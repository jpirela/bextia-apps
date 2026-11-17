import { Hono } from "hono";
import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { booking, incident, incident_action, message, type IncidentState, type IncidentType, type IncidentUrgency } from "../db/schema.ts";
import { requireRole, type AuthEnv } from "../auth/roles.ts";
import type { Db } from "../db/index.ts";
import { canTransition, InvalidTransitionError, logAction, saveIncident, StaleIncidentError } from "../incidents/store.ts";
import { dateParam, invalid, notFound, readJson, UUID_RE, type Issue } from "./http.ts";
import type { ApiDeps } from "./index.ts";

const STATES: IncidentState[] = ["identificando", "bienvenida", "clasificando", "protocolo", "conversacional", "escalado", "seguimiento", "cerrado"];
const TYPES: IncidentType[] = ["traslado_no_presentado", "consulta", "emergencia", "otra"];
const URGENCIES: IncidentUrgency[] = ["baja", "media", "alta", "critica"];
const ACTIONS = ["tomar", "cerrar", "reembolso"] as const;

const listSelect = {
  id: incident.id, tipologia: incident.tipologia, urgencia: incident.urgencia, estado: incident.estado,
  requiere_humano: incident.requiere_humano, resumen_ia: incident.resumen_ia, escalado_a: incident.escalado_a,
  sla_vence: incident.sla_vence, created_at: incident.created_at, cerrado_at: incident.cerrado_at,
  conversation_id: incident.conversation_id,
  reserva: { codigo: booking.codigo, destino: booking.destino, viajero_nombre: booking.viajero_nombre },
};

export function incidentsRoutes(deps: ApiDeps): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
  const now = deps.now ?? (() => new Date());
  r.use("*", requireRole("admin", "operador"));

  const base = (where: SQL | undefined) =>
    deps.db.select(listSelect).from(incident).innerJoin(booking, eq(incident.booking_id, booking.id)).where(where);

  r.get("/", async (c) => {
    const q = c.req.query();
    const conds: SQL[] = [];
    const enums = [["estado", STATES, incident.estado], ["tipologia", TYPES, incident.tipologia], ["urgencia", URGENCIES, incident.urgencia]] as const;
    for (const [k, allowed, col] of enums) {
      if (q[k] === undefined) continue;
      if (!(allowed as readonly string[]).includes(q[k])) return invalid(c, [{ field: k, code: "enum", message: `${k} inválido` }]);
      conds.push(eq(col, q[k] as never));
    }
    if (q.requiere_humano !== undefined) {
      if (q.requiere_humano !== "true" && q.requiere_humano !== "false") return invalid(c, [{ field: "requiere_humano", code: "bool", message: "true o false" }]);
      conds.push(eq(incident.requiere_humano, q.requiere_humano === "true"));
    }
    for (const [k, op] of [["desde", gte], ["hasta", lt]] as const) {
      if (q[k] === undefined) continue;
      const d = dateParam(q[k]);
      if (!d) return invalid(c, [{ field: k, code: "date", message: "fecha inválida" }]);
      conds.push(op(incident.created_at, d));
    }
    const rows = await base(conds.length ? and(...conds) : undefined)
      .orderBy(desc(incident.requiere_humano), sql`${incident.sla_vence} asc nulls last`, desc(incident.created_at)).limit(500);
    return c.json({ data: rows.map(({ conversation_id: _c, ...x }) => x) });
  });

  r.get("/:id", async (c) => {
    const incId = c.req.param("id");
    if (!UUID_RE.test(incId)) return notFound(c);
    const [row] = await base(eq(incident.id, incId));
    if (!row) return notFound(c);
    const acciones = await deps.db.select({ tipo: incident_action.tipo, detalle: incident_action.detalle, monto: incident_action.monto, created_at: incident_action.created_at })
      .from(incident_action).where(eq(incident_action.incident_id, incId)).orderBy(asc(incident_action.created_at), asc(incident_action.id));
    const conversacion = row.conversation_id
      ? await deps.db.select({ direccion: message.direccion, contenido: message.contenido, created_at: message.created_at })
        .from(message).where(eq(message.conversation_id, row.conversation_id)).orderBy(asc(message.created_at), asc(message.id))
      : [];
    const { conversation_id: _c, ...rest } = row;
    return c.json({ ...rest, acciones, conversacion });
  });

  r.patch("/:id", async (c) => {
    const incId = c.req.param("id");
    if (!UUID_RE.test(incId)) return notFound(c);
    const body = await readJson(c);
    const issues: Issue[] = [];
    const accion = body?.accion as (typeof ACTIONS)[number];
    if (!ACTIONS.includes(accion)) issues.push({ field: "accion", code: "enum", message: "acción inválida" });
    const nota = body?.nota;
    if (nota !== undefined && (typeof nota !== "string" || nota.length > 500)) issues.push({ field: "nota", code: "max", message: "máximo 500 caracteres" });
    if (issues.length) return invalid(c, issues);
    // La nota puede contener PII: se guarda en detalle y nunca se loguea.
    const notaDet = typeof nota === "string" && nota.trim() ? { nota: nota.trim() } : {};

    const user = c.get("user");
    // M3: sin email no hay responsable al que escalar.
    if (accion === "tomar" && !user.email) return invalid(c, [{ field: "email", code: "required", message: "el token no trae email" }]);
    // M6: se valida en céntimos, ya redondeado, para que 0,004 no pase como "0.00".
    let cents = 0;
    if (accion === "reembolso") {
      const monto = body?.monto;
      cents = typeof monto === "number" && Number.isFinite(monto) ? Math.round(monto * 100) : 0;
      if (cents < 1) return invalid(c, [{ field: "monto", code: "min", message: "monto mayor que 0" }]);
    }

    type Out = { status: 200 | 400 | 404 | 409; body: unknown };
    // I1: lectura con FOR UPDATE, transición validada contra el estado leído y traza en la misma transacción.
    const out: Out = await deps.db.transaction(async (txRaw): Promise<Out> => {
      const tx = txRaw as unknown as Db;
      const [cur] = await tx.select().from(incident).where(eq(incident.id, incId)).for("update");
      if (!cur) return { status: 404, body: { error: "not_found" } };
      if (cur.estado === "cerrado") return { status: 409, body: { error: "closed" } };

      if (accion === "cerrar") {
        const row = await saveIncident(tx, cur, { estado: "cerrado", requiere_humano: false, proximo_paso_at: null }, now());
        await logAction(tx, incId, "resultado", { cierre: user.role, ...notaDet });
        return { status: 200, body: row };
      }

      if (accion === "tomar") {
        if (!canTransition(cur.estado, "escalado")) return { status: 409, body: { error: "invalid_transition", from: cur.estado } };
        const row = await saveIncident(tx, cur, { estado: "escalado", escalado_a: user.email, requiere_humano: true, proximo_paso_at: null }, now());
        await logAction(tx, incId, "escalado", { por: user.role, ...notaDet });
        return { status: 200, body: row };
      }

      // reembolso (P34, I2): el acumulado de reembolsos no supera lo autorizado. El FOR UPDATE serializa.
      const [auth] = await tx.select({ monto: incident_action.monto }).from(incident_action)
        .where(and(eq(incident_action.incident_id, incId), eq(incident_action.tipo, "autorizacion")))
        .orderBy(desc(incident_action.created_at), desc(incident_action.id)).limit(1);
      if (!auth?.monto) return { status: 409, body: { error: "no_authorization" } };
      const [{ previo }] = await tx.select({ previo: sql<string>`coalesce(sum(${incident_action.monto}), 0)` }).from(incident_action)
        .where(and(eq(incident_action.incident_id, incId), eq(incident_action.tipo, "resultado"),
          sql`${incident_action.detalle}->>'reembolso' = 'true'`));
      const topeCents = Math.round(Number(auth.monto) * 100);
      const previoCents = Math.round(Number(previo) * 100);
      if (previoCents + cents > topeCents) {
        const resto = (Math.max(topeCents - previoCents, 0) / 100).toFixed(2);
        return { status: 400, body: { error: "invalid", issues: [{ field: "monto", code: "max", message: `máximo ${resto}` }] } };
      }
      await logAction(tx, incId, "resultado", { reembolso: true, ...notaDet }, cents / 100);
      return { status: 200, body: cur };
    }).catch((err: unknown): Out => {
      if (err instanceof InvalidTransitionError || err instanceof StaleIncidentError) return { status: 409, body: { error: "conflict" } };
      throw err;
    });
    return c.json(out.body as object, out.status);
  });

  return r;
}
