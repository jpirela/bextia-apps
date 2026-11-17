import { Hono, type Context } from "hono";
import { and, asc, gte, lt } from "drizzle-orm";
import { incident, kpi_event, lead } from "../db/schema.ts";
import { requireRole, type AuthEnv } from "../auth/roles.ts";
import { dateParam, invalid } from "./http.ts";
import type { ApiDeps } from "./index.ts";

const DAY = 86_400_000;

export function parseRange(c: Context, now: Date, defaultDays = 30, maxDays = 366): { desde: Date; hasta: Date } | Response {
  const q = c.req.query();
  const hasta = q.hasta ? dateParam(q.hasta) : now;
  const desde = q.desde ? dateParam(q.desde) : new Date((hasta ?? now).getTime() - defaultDays * DAY);
  if (!desde || !hasta) return invalid(c, [{ field: q.desde && !desde ? "desde" : "hasta", code: "date", message: "fecha inválida" }]);
  if (hasta <= desde) return invalid(c, [{ field: "hasta", code: "range", message: "hasta debe ser posterior a desde" }]);
  if (hasta.getTime() - desde.getTime() > maxDays * DAY) return invalid(c, [{ field: "desde", code: "range", message: `máximo ${maxDays} días` }]);
  return { desde, hasta };
}

export function kpiRoutes(deps: ApiDeps): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
  const now = deps.now ?? (() => new Date());
  r.use("*", requireRole("admin"));
  r.get("/", async (c) => {
    const range = parseRange(c, now());
    if (range instanceof Response) return range;
    const { desde, hasta } = range;
    const [eventos, leads, incidencias] = await Promise.all([
      deps.db.select({ tipo: kpi_event.tipo, agente: kpi_event.agente, canal: kpi_event.canal, valor: kpi_event.valor, created_at: kpi_event.created_at })
        .from(kpi_event).where(and(gte(kpi_event.created_at, desde), lt(kpi_event.created_at, hasta))).orderBy(asc(kpi_event.created_at)),
      deps.db.select({ estado: lead.estado, score: lead.score, mercado: lead.mercado, created_at: lead.created_at, entregado_at: lead.entregado_at })
        .from(lead).where(and(gte(lead.created_at, desde), lt(lead.created_at, hasta))),
      deps.db.select({ tipologia: incident.tipologia, urgencia: incident.urgencia, estado: incident.estado, requiere_humano: incident.requiere_humano, created_at: incident.created_at, cerrado_at: incident.cerrado_at })
        .from(incident).where(and(gte(incident.created_at, desde), lt(incident.created_at, hasta))),
    ]);
    return c.json({ rango: { desde: desde.toISOString(), hasta: hasta.toISOString() }, eventos, leads, incidencias });
  });
  return r;
}
