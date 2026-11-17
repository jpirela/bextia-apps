import { Hono } from "hono";
import { and, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { contact, lead, sales_agent, type LeadState } from "../db/schema.ts";
import { requireRole, type AuthEnv } from "../auth/roles.ts";
import { invalid } from "./http.ts";
import { toCsv } from "./csv.ts";
import { parseRange } from "./kpi.ts";
import type { ApiDeps } from "./index.ts";
import { LEAD_STATES } from "./leads.ts";

export function exportRoutes(deps: ApiDeps): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
  const now = deps.now ?? (() => new Date());
  r.use("*", requireRole("admin"));
  r.get("/leads.csv", async (c) => {
    const range = parseRange(c, now(), 30, 731);
    if (range instanceof Response) return range;
    const conds: SQL[] = [gte(lead.created_at, range.desde), lt(lead.created_at, range.hasta)];
    const estado = c.req.query("estado");
    if (estado) {
      if (!LEAD_STATES.includes(estado as LeadState)) return invalid(c, [{ field: "estado", code: "enum", message: "estado inválido" }]);
      conds.push(eq(lead.estado, estado as LeadState));
    }
    const rows = await deps.db.select({
      created_at: lead.created_at, estado: lead.estado, score: lead.score, destino: lead.destino, mercado: lead.mercado,
      nombre: contact.nombre, email: contact.email, telefono: contact.telefono, comercial: sales_agent.nombre, entregado_at: lead.entregado_at,
    }).from(lead).innerJoin(contact, eq(lead.contact_id, contact.id)).leftJoin(sales_agent, eq(lead.sales_agent_id, sales_agent.id))
      .where(and(...conds)).orderBy(desc(lead.created_at)).limit(50_000);
    const csv = toCsv([
      ["creado", "estado", "score", "destino", "mercado", "contacto", "email", "telefono", "comercial", "entregado"],
      ...rows.map((x) => [x.created_at, x.estado, x.score, x.destino, x.mercado, x.nombre, x.email, x.telefono, x.comercial, x.entregado_at]),
    ]);
    const day = now().toISOString().slice(0, 10);
    return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="leads-${day}.csv"`, "cache-control": "no-store" });
  });
  return r;
}
