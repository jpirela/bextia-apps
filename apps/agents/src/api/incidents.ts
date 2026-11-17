import { Hono } from "hono";
import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { booking, incident, incident_action, message, type IncidentState, type IncidentType, type IncidentUrgency } from "../db/schema.ts";
import { requireRole, type AuthEnv } from "../auth/roles.ts";
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
      .from(incident_action).where(eq(incident_action.incident_id, incId)).orderBy(asc(incident_action.created_at));
    const conversacion = row.conversation_id
      ? await deps.db.select({ direccion: message.direccion, contenido: message.contenido, created_at: message.created_at })
        .from(message).where(eq(message.conversation_id, row.conversation_id)).orderBy(asc(message.created_at))
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

    const [cur] = await deps.db.select().from(incident).where(eq(incident.id, incId));
    if (!cur) return notFound(c);
    const user = c.get("user");

    if (accion === "cerrar") {
      if (cur.estado === "cerrado") return c.json(cur);
      const [row] = await deps.db.update(incident).set({ estado: "cerrado", cerrado_at: now(), requiere_humano: false }).where(eq(incident.id, incId)).returning();
      await deps.db.insert(incident_action).values({ incident_id: incId, tipo: "resultado", detalle: { cierre: user.role, ...notaDet } });
      return c.json(row);
    }
    if (cur.estado === "cerrado") return c.json({ error: "closed" }, 409);

    if (accion === "tomar") {
      const [row] = await deps.db.update(incident).set({ estado: "escalado", escalado_a: user.email, requiere_humano: true }).where(eq(incident.id, incId)).returning();
      await deps.db.insert(incident_action).values({ incident_id: incId, tipo: "escalado", detalle: { por: user.role, ...notaDet } });
      return c.json(row);
    }

    // reembolso (P34): solo hasta lo autorizado por el protocolo o el operador.
    const monto = body?.monto;
    if (typeof monto !== "number" || !Number.isFinite(monto) || monto <= 0) return invalid(c, [{ field: "monto", code: "min", message: "monto mayor que 0" }]);
    const [auth] = await deps.db.select({ monto: incident_action.monto }).from(incident_action)
      .where(and(eq(incident_action.incident_id, incId), eq(incident_action.tipo, "autorizacion")))
      .orderBy(desc(incident_action.created_at)).limit(1);
    if (!auth?.monto) return c.json({ error: "no_authorization" }, 409);
    if (monto > Number(auth.monto)) return invalid(c, [{ field: "monto", code: "max", message: `máximo ${auth.monto}` }]);
    await deps.db.insert(incident_action).values({ incident_id: incId, tipo: "resultado", monto: monto.toFixed(2), detalle: { reembolso: true, ...notaDet } });
    return c.json(cur);
  });

  return r;
}
