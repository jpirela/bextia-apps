import { count, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { lead, sales_agent, type LeadType } from "../db/schema.ts";

export type SalesAgentRow = typeof sales_agent.$inferSelect;

export interface AssignInput {
  destino: string | null;
  idioma: string | null;
  mercado: string | null;
  tipo: LeadType | null;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

const inList = (list: string[], v: string) => list.some((x) => norm(x) === norm(v));

// Elegible si la lista está vacía o el lead no tiene el dato, o si la lista contiene su valor.
const eligibleOn = (list: string[], v: string | null) => list.length === 0 || v === null || inList(list, v);

function matchScore(a: SalesAgentRow, i: AssignInput): number {
  let score = 0;
  if (i.destino) {
    const d = norm(i.destino);
    const hit = a.destinos.some((x) => {
      const n = norm(x);
      return n !== "" && (d.includes(n) || n.includes(d));
    });
    if (hit) score += 4;
  }
  if (i.idioma && inList(a.idiomas, i.idioma)) score += 2;
  if (i.mercado && inList(a.mercados, i.mercado)) score += 2;
  if (i.tipo && a.tipos_lead.includes(i.tipo)) score += 1;
  return score;
}

export async function assignSalesAgent(db: Db, input: AssignInput): Promise<SalesAgentRow | null> {
  const agents = (await db.select().from(sales_agent).where(eq(sales_agent.activo, true))).filter(
    (a) => eligibleOn(a.idiomas, input.idioma) && eligibleOn(a.mercados, input.mercado),
  );
  if (agents.length === 0) return null;

  const loads = await db
    .select({ id: lead.sales_agent_id, n: count() })
    .from(lead)
    .where(eq(lead.estado, "asignado"))
    .groupBy(lead.sales_agent_id);
  const load = new Map(loads.map((l) => [l.id, Number(l.n)]));

  return agents
    .map((a) => ({ a, score: matchScore(a, input), load: load.get(a.id) ?? 0 }))
    .sort((x, y) => y.score - x.score || x.load - y.load || x.a.nombre.localeCompare(y.a.nombre))[0].a;
}
