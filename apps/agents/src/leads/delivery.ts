import { and, eq, inArray, isNotNull, max } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { contact, kpi_event, lead, message, sales_agent } from "../db/schema.ts";
import { assignSalesAgent } from "./assign.ts";
import { plainSummary, type QualFacts } from "./qualify.ts";
import { hmacSha256Hex } from "../channels/errors.ts";
import type { Mailer } from "../notify/mailer.ts";
import type { LeadRow } from "./store.ts";
import { isWithinBusinessHours, ruleFromRow } from "../orchestrator/business-hours.ts";
import type { WeeklyHours } from "../db/schema.ts";

export interface DeliveryDeps {
  db: Db;
  mailer: Mailer | null;
  webhook?: { url: string; secret: string; fetch?: typeof fetch } | null;
  backofficeUrl?: string | null;
  now?: () => Date;
  startHour?: number;
  endHour?: number;
  /** Inactividad (ms) tras la cual un lead fuera de horario incompleto se promueve a un comercial. Por defecto 2 h. */
  staleAfterMs?: number;
}

const DEFAULT_TZ = "Europe/Madrid";
const WORKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

// Jornada = lunes a viernes, [startHour, endHour) en la zona del comercial.
export function workdayStarted(timeZone: string | null, now: Date, startHour = 8, endHour = 19): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone || DEFAULT_TZ, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return WORKDAYS.has(weekday) && hour >= startHour && hour < endHour;
}

// P19: con horario propio manda ese horario; sin él, la jornada por omisión (workdayStarted resuelve null a DEFAULT_TZ).
export function agentAvailable(
  agent: { zona_horaria: string | null; horario: WeeklyHours | null; festivos: string[] },
  now: Date,
  hours: { startHour?: number; endHour?: number } = {},
): boolean {
  if (agent.horario && agent.zona_horaria) {
    return isWithinBusinessHours(ruleFromRow({ zona_horaria: agent.zona_horaria, horario: agent.horario, festivos: agent.festivos }), now);
  }
  return workdayStarted(agent.zona_horaria, now, hours.startHour, hours.endHour);
}

type Row = { lead: LeadRow; agent: typeof sales_agent.$inferSelect; contact: typeof contact.$inferSelect };

async function loadAssigned(db: Db, leadIds?: string[]): Promise<Row[]> {
  const conds = [eq(lead.estado, "asignado"), isNotNull(lead.sales_agent_id)];
  if (leadIds) conds.push(inArray(lead.id, leadIds));
  return db.select({ lead, agent: sales_agent, contact }).from(lead)
    .innerJoin(sales_agent, eq(lead.sales_agent_id, sales_agent.id))
    .innerJoin(contact, eq(lead.contact_id, contact.id))
    .where(and(...conds));
}

function leadBlock(r: Row, backofficeUrl?: string | null): string {
  const l = r.lead;
  return [
    `${l.destino ?? "Sin destino"} · score ${l.score ?? 0}${l.requiere_humano ? " · revisar" : ""}`,
    l.resumen_ia ?? "",
    `Fechas: ${l.fecha_inicio ?? "?"} a ${l.fecha_fin ?? "?"} · Viajeros: ${l.viajeros ?? "?"} · Urgencia: ${l.urgencia ?? "?"}`,
    `Contacto: ${r.contact.nombre ?? "—"} · ${r.contact.telefono ?? "—"} · ${r.contact.email ?? "—"}`,
    backofficeUrl ? `${backofficeUrl.replace(/\/+$/, "")}/leads/${l.id}` : "",
  ].filter(Boolean).join("\n");
}

async function postWebhook(deps: DeliveryDeps, r: Row): Promise<void> {
  if (!deps.webhook) return;
  const body = JSON.stringify({
    event: "lead.entregado",
    lead: {
      id: r.lead.id, destino: r.lead.destino, fecha_inicio: r.lead.fecha_inicio, fecha_fin: r.lead.fecha_fin,
      viajeros: r.lead.viajeros, interes: r.lead.interes, urgencia: r.lead.urgencia, tipo: r.lead.tipo,
      score: r.lead.score, resumen_ia: r.lead.resumen_ia, mercado: r.lead.mercado, idioma: r.lead.idioma,
      sales_agent_email: r.agent.email,
    },
  });
  try {
    const res = await (deps.webhook.fetch ?? fetch)(deps.webhook.url, {
      method: "POST", signal: AbortSignal.timeout(5_000), body,
      headers: { "content-type": "application/json", "x-bextia-signature": `sha256=${hmacSha256Hex(deps.webhook.secret, body)}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error("leads: webhook fallido", (err as Error).name);
    await deps.db.insert(kpi_event).values({ tipo: "webhook_fallido", agente: "leads", ref_id: r.lead.id });
  }
}

async function markDelivered(deps: DeliveryDeps, rows: Row[], at: Date): Promise<void> {
  for (const r of rows) {
    const updated = await deps.db.update(lead).set({ estado: "entregado", entregado_at: at })
      .where(and(eq(lead.id, r.lead.id), eq(lead.estado, "asignado"))).returning({ id: lead.id });
    if (updated.length === 0) continue; // otra entrega ganó la carrera: sin KPI ni webhook duplicados
    await deps.db.insert(kpi_event).values({
      tipo: "lead_entregado", agente: "leads", ref_id: r.lead.id,
      valor: (at.getTime() - r.lead.created_at.getTime()) / 60_000, // minutos hasta la entrega
    });
    await postWebhook(deps, r);
  }
}

export async function deliverLead(deps: DeliveryDeps, leadId: string): Promise<boolean> {
  if (!deps.mailer) return false;
  const [r] = await loadAssigned(deps.db, [leadId]);
  if (!r) return false;
  await deps.mailer.send({
    to: r.agent.email,
    subject: `BEXTIA · Nuevo lead: ${r.lead.destino ?? "sin destino"} (score ${r.lead.score ?? 0})`,
    text: leadBlock(r, deps.backofficeUrl),
  });
  await markDelivered(deps, [r], (deps.now ?? (() => new Date()))());
  return true;
}

const STALE_STATES = ["nuevo", "respondido", "cualificando"] as const;
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

// Promueve leads fuera de horario que no completaron la cualificación (cliente inactivo o LLM caído)
// para que lleguen al comercial marcados "revisar". Escribe `asignado` directo con db.update (salta
// saveLead y su máquina de estados nuevo/respondido/cualificando -> cualificado -> asignado): es
// aceptable aquí porque el UPDATE lleva guarda optimista sobre el estado leído.
async function promoteStale(deps: DeliveryDeps, now: Date): Promise<void> {
  const staleMs = deps.staleAfterMs ?? DEFAULT_STALE_MS;
  const candidates = await deps.db.select().from(lead)
    .where(and(eq(lead.fuera_de_horario, true), inArray(lead.estado, [...STALE_STATES])));
  for (const l of candidates) {
    try { await promoteOne(deps, l, now, staleMs); } catch (err) {
      console.error("leads: promoción de lead inactivo fallida", (err as Error).name);
    }
  }
}

async function promoteOne(deps: DeliveryDeps, l: LeadRow, now: Date, staleMs: number): Promise<void> {
  {
    let last = l.created_at;
    if (l.conversation_id) {
      const [m] = await deps.db.select({ at: max(message.created_at) }).from(message)
        .where(eq(message.conversation_id, l.conversation_id));
      if (m?.at) last = m.at;
    }
    if (now.getTime() - last.getTime() < staleMs) return;
    const facts: QualFacts = {
      destino: l.destino, fecha_inicio: l.fecha_inicio, fecha_fin: l.fecha_fin, viajeros: l.viajeros,
      interes: l.interes, urgencia: l.urgencia, tipo: l.tipo, idioma: l.idioma as QualFacts["idioma"],
      nombre: null, email: null, telefono: null,
    };
    const agent = await assignSalesAgent(deps.db, { destino: l.destino, idioma: l.idioma, mercado: l.mercado, tipo: l.tipo });
    if (!agent) {
      await deps.db.update(lead).set({ requiere_humano: true })
        .where(and(eq(lead.id, l.id), eq(lead.estado, l.estado)));
      return;
    }
    await deps.db.update(lead).set({
      estado: "asignado", sales_agent_id: agent.id, resumen_ia: l.resumen_ia ?? plainSummary(facts), requiere_humano: true,
    }).where(and(eq(lead.id, l.id), eq(lead.estado, l.estado)));
  }
}

export async function deliverDue(deps: DeliveryDeps): Promise<{ delivered: number; failed: number }> {
  if (!deps.mailer) return { delivered: 0, failed: 0 };
  const now = (deps.now ?? (() => new Date()))();
  await promoteStale(deps, now);
  const byAgent = new Map<string, Row[]>();
  for (const r of await loadAssigned(deps.db)) {
    if (!agentAvailable(r.agent, now, { startHour: deps.startHour, endHour: deps.endHour })) continue;
    byAgent.set(r.agent.id, [...(byAgent.get(r.agent.id) ?? []), r]);
  }
  let delivered = 0;
  let failed = 0;
  for (const rows of byAgent.values()) {
    rows.sort((a, b) => (b.lead.score ?? 0) - (a.lead.score ?? 0));
    try {
      await deps.mailer.send({
        to: rows[0].agent.email,
        subject: `BEXTIA · ${rows.length} ${rows.length === 1 ? "lead nuevo" : "leads nuevos"}`,
        text: rows.map((r) => leadBlock(r, deps.backofficeUrl)).join("\n\n———\n\n"),
      });
    } catch (err) {
      console.error("leads: email de entrega fallido", (err as Error).name);
      failed += rows.length;
      continue;
    }
    await markDelivered(deps, rows, now);
    delivered += rows.length;
  }
  return { delivered, failed };
}
