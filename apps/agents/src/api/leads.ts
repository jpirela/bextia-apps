import { Hono } from "hono";
import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { contact, lead, message, sales_agent, type LeadState } from "../db/schema.ts";
import { requireRole, type AuthEnv, type AuthUser } from "../auth/roles.ts";
import { dateParam, invalid, notFound, readJson, UUID_RE } from "./http.ts";
import type { ApiDeps } from "./index.ts";

export const LEAD_STATES: LeadState[] = ["nuevo", "respondido", "cualificando", "cualificado", "asignado", "entregado"];

const listSelect = {
  id: lead.id, destino: lead.destino, fecha_inicio: lead.fecha_inicio, fecha_fin: lead.fecha_fin, viajeros: lead.viajeros,
  tipo: lead.tipo, urgencia: lead.urgencia, score: lead.score, estado: lead.estado, requiere_humano: lead.requiere_humano,
  mercado: lead.mercado, idioma: lead.idioma, resumen_ia: lead.resumen_ia, created_at: lead.created_at, entregado_at: lead.entregado_at,
  conversation_id: lead.conversation_id,
  contacto: { nombre: contact.nombre, email: contact.email, telefono: contact.telefono },
  comercial_id: sales_agent.id, comercial_nombre: sales_agent.nombre,
};

type Raw = Awaited<ReturnType<typeof baseQuery>>[number];
const shape = ({ comercial_id, comercial_nombre, conversation_id: _c, ...r }: Raw) => ({
  ...r, comercial: comercial_id ? { id: comercial_id, nombre: comercial_nombre } : null,
});

function baseQuery(db: Db, where: SQL | undefined) {
  return db.select(listSelect).from(lead)
    .innerJoin(contact, eq(lead.contact_id, contact.id))
    .leftJoin(sales_agent, eq(lead.sales_agent_id, sales_agent.id))
    .where(where);
}

// Restricción por rol: el comercial solo ve los leads asignados a su email.
async function scope(db: Db, user: AuthUser): Promise<SQL | null | "none"> {
  if (user.role !== "comercial") return null;
  if (!user.email) return "none";
  const [ag] = await db.select({ id: sales_agent.id }).from(sales_agent).where(sql`lower(${sales_agent.email}) = ${user.email}`);
  return ag ? eq(lead.sales_agent_id, ag.id) : "none";
}

export function leadsRoutes(deps: ApiDeps): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
  r.use("*", requireRole("admin", "comercial"));

  r.get("/", async (c) => {
    const q = c.req.query();
    const conds: SQL[] = [];
    if (q.estado) {
      if (!LEAD_STATES.includes(q.estado as LeadState)) return invalid(c, [{ field: "estado", code: "enum", message: "estado inválido" }]);
      conds.push(eq(lead.estado, q.estado as LeadState));
    }
    for (const [k, op] of [["desde", gte], ["hasta", lt]] as const) {
      if (q[k] === undefined) continue;
      const d = dateParam(q[k]);
      if (!d) return invalid(c, [{ field: k, code: "date", message: "fecha inválida" }]);
      conds.push(op(lead.created_at, d));
    }
    if (q.sales_agent_id) {
      if (!UUID_RE.test(q.sales_agent_id)) return invalid(c, [{ field: "sales_agent_id", code: "uuid", message: "id inválido" }]);
      conds.push(eq(lead.sales_agent_id, q.sales_agent_id));
    }
    const s = await scope(deps.db, c.get("user"));
    if (s === "none") return c.json({ data: [] });
    if (s) conds.push(s);
    const rows = await baseQuery(deps.db, conds.length ? and(...conds) : undefined).orderBy(desc(lead.created_at)).limit(500);
    return c.json({ data: rows.map(shape) });
  });

  r.get("/:id", async (c) => {
    const leadId = c.req.param("id");
    if (!UUID_RE.test(leadId)) return notFound(c);
    const s = await scope(deps.db, c.get("user"));
    if (s === "none") return notFound(c);
    const [row] = await baseQuery(deps.db, and(eq(lead.id, leadId), s ?? undefined));
    if (!row) return notFound(c);
    const conversacion = row.conversation_id
      ? await deps.db.select({ direccion: message.direccion, contenido: message.contenido, created_at: message.created_at })
        .from(message).where(eq(message.conversation_id, row.conversation_id)).orderBy(asc(message.created_at), asc(message.id))
      : [];
    return c.json({ ...shape(row), conversacion });
  });

  r.patch("/:id", requireRole("admin"), async (c) => {
    const leadId = c.req.param("id");
    if (!UUID_RE.test(leadId)) return notFound(c);
    const body = await readJson(c);
    if (!body) return invalid(c, [{ field: "", code: "json", message: "cuerpo inválido" }]);
    const set: Partial<typeof lead.$inferInsert> = {};
    if ("estado" in body) {
      if (!LEAD_STATES.includes(body.estado as LeadState)) return invalid(c, [{ field: "estado", code: "enum", message: "estado inválido" }]);
      set.estado = body.estado as LeadState;
    }
    if ("sales_agent_id" in body) {
      const v = body.sales_agent_id;
      if (v !== null) {
        if (typeof v !== "string" || !UUID_RE.test(v)) return invalid(c, [{ field: "sales_agent_id", code: "uuid", message: "id inválido" }]);
        const [ag] = await deps.db.select({ id: sales_agent.id }).from(sales_agent).where(eq(sales_agent.id, v));
        if (!ag) return invalid(c, [{ field: "sales_agent_id", code: "ref", message: "comercial inexistente" }]);
      }
      set.sales_agent_id = v as string | null;
    }
    if (!Object.keys(set).length) return invalid(c, [{ field: "", code: "empty", message: "nada para actualizar" }]);
    // El admin salta la máquina de estados: sin esto el KPI tasaEntrega y el export quedan sin fecha (I11).
    // M2: solo la primera entrega fija la fecha; un PATCH repetido no desplaza el KPI.
    if (set.estado === "entregado") {
      const [prev] = await deps.db.select({ entregado_at: lead.entregado_at }).from(lead).where(eq(lead.id, leadId));
      if (!prev) return notFound(c);
      if (!prev.entregado_at) set.entregado_at = (deps.now ?? (() => new Date()))();
    }
    const [row] = await deps.db.update(lead).set(set).where(eq(lead.id, leadId)).returning();
    return row ? c.json(row) : notFound(c);
  });

  return r;
}
