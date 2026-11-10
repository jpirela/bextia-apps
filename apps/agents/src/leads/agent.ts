import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { conversation, kpi_event, message } from "../db/schema.ts";
import type { InboundMessage, OutboundMessage } from "../channels/types.ts";
import { completeContact, type ContactRow } from "../gateway/ingest.ts";
import { FALLBACK_REPLY, type Llm } from "../llm/types.ts";
import type { KbHit, KnowledgeBase } from "../rag/kb.ts";
import type { Dispatch } from "../server/pipeline.ts";
import { assignSalesAgent } from "./assign.ts";
import { buildConversationSystem, toMessageParams, UNSUPPORTED_REPLY } from "./prompts.ts";
import { extractQualification, mergeQualification, missingFields, summarizeLead, type QualFacts, type Qualification, type Turn } from "./qualify.ts";
import { DEFAULT_SCORING, scoreLead, type ScoringRules } from "./scoring.ts";
import { findOrCreateLead, saveLead, type LeadRow } from "./store.ts";

export interface LeadsAgentDeps {
  db: Db;
  llm: Llm;
  kb: KnowledgeBase;
  send: (msg: OutboundMessage) => Promise<{ externalId: string }>;
  notifyNow: (leadId: string) => Promise<void>;
  scoring?: ScoringRules;
  now?: () => Date;
}

const HISTORY_LIMIT = 30;

function factsOf(l: LeadRow, c: ContactRow): QualFacts {
  return {
    destino: l.destino, fecha_inicio: l.fecha_inicio, fecha_fin: l.fecha_fin, viajeros: l.viajeros, interes: l.interes,
    urgencia: l.urgencia, tipo: l.tipo, idioma: (l.idioma as QualFacts["idioma"]) ?? null,
    nombre: c.nombre, email: c.email, telefono: c.telefono,
  };
}

function tripPatch(f: QualFacts) {
  return {
    destino: f.destino, fecha_inicio: f.fecha_inicio, fecha_fin: f.fecha_fin, viajeros: f.viajeros,
    interes: f.interes, urgencia: f.urgencia, tipo: f.tipo, idioma: f.idioma,
  };
}

async function history(db: Db, conversationId: string): Promise<Turn[]> {
  const rows = await db.select({ direccion: message.direccion, contenido: message.contenido }).from(message)
    .where(eq(message.conversation_id, conversationId)).orderBy(desc(message.created_at)).limit(HISTORY_LIMIT);
  return rows.reverse() as Turn[];
}

async function kpi(db: Db, tipo: string, msg: InboundMessage, refId: string, valor?: number) {
  await db.insert(kpi_event).values({ tipo, agente: "leads", canal: msg.channel, ref_id: refId, valor: valor ?? null });
}

export function createLeadsAgent(deps: LeadsAgentDeps): Dispatch {
  const { db, llm, kb } = deps;
  const now = deps.now ?? (() => new Date());
  const rules = deps.scoring ?? DEFAULT_SCORING;

  async function reply(msg: InboundMessage, c: ContactRow, conversationId: string, leadId: string, text: string): Promise<boolean> {
    const to: OutboundMessage["to"] = {};
    if (msg.from.phone ?? c.telefono) to.phone = (msg.from.phone ?? c.telefono) as string;
    if (msg.from.email ?? c.email) to.email = (msg.from.email ?? c.email) as string;
    const out: OutboundMessage = { channel: msg.channel, to, text };
    if (msg.subject) out.subject = `Re: ${msg.subject}`;
    try {
      const r = await deps.send(out);
      await db.insert(message).values({
        conversation_id: conversationId, canal: msg.channel, direccion: "out", contenido: text,
        external_id: r.externalId || `out-${randomUUID()}`, agente: "leads",
      });
      await kpi(db, "respuesta_enviada", msg, leadId, now().getTime() - msg.receivedAt.getTime());
      return true;
    } catch (err) {
      console.error("leads: envío fallido", (err as Error).name);
      await kpi(db, "envio_fallido", msg, leadId);
      return false;
    }
  }

  async function qualifyAndAssign(l: LeadRow, facts: QualFacts, turns: Turn[]): Promise<{ l: LeadRow; assigned: boolean }> {
    if (l.estado === "nuevo" || l.estado === "respondido" || l.estado === "cualificando") {
      l = await saveLead(db, l, { estado: "cualificado" });
    }
    if (l.estado !== "cualificado") return { l, assigned: false };
    const resumen = await summarizeLead(llm, facts, turns);
    const agent = await assignSalesAgent(db, { destino: facts.destino, idioma: facts.idioma, mercado: l.mercado, tipo: facts.tipo });
    if (!agent) return { l: await saveLead(db, l, { resumen_ia: resumen, requiere_humano: true }), assigned: false };
    return { l: await saveLead(db, l, { resumen_ia: resumen, sales_agent_id: agent.id, estado: "asignado" }), assigned: true };
  }

  return async ({ msg, ingest, decision }) => {
    if (decision.agent !== "leads") return;
    const outOfHours = !decision.withinHours;
    let { lead: l } = await findOrCreateLead(db, {
      contactId: ingest.contact.id, conversationId: ingest.conversationId, mercado: decision.market, fueraDeHorario: outOfHours,
    });
    await db.update(conversation).set({ agente: "leads" })
      .where(and(eq(conversation.id, ingest.conversationId), isNull(conversation.agente)));

    if (msg.unsupported) {
      if (outOfHours) await reply(msg, ingest.contact, ingest.conversationId, l.id, UNSUPPORTED_REPLY);
      return;
    }

    const turns = await history(db, ingest.conversationId);
    const extracted = await extractQualification(llm, turns, now().toISOString().slice(0, 10));
    const q: Qualification | null = extracted.ok ? extracted.value : null;
    let requiereHumano = l.requiere_humano || !extracted.ok;

    const c = await completeContact(db, ingest.contact, { name: q?.nombre, email: q?.email, phone: q?.telefono });
    const facts = mergeQualification(factsOf(l, c), q);
    const hasContact = Boolean(c.telefono || c.email);
    const score = scoreLead({ ...facts, tieneContacto: hasContact }, now(), rules);
    const missing = missingFields(facts, hasContact);
    l = await saveLead(db, l, { ...tripPatch(facts), score });

    if (!outOfHours) {
      const r = await qualifyAndAssign(l, facts, turns);
      l = r.l;
      if (r.assigned) {
        try { await deps.notifyNow(l.id); } catch (err) {
          // El cron de entrega reintenta: el lead sigue en "asignado".
          console.error("leads: notificación inmediata fallida", (err as Error).name);
        }
      }
      await saveLead(db, l, { requiere_humano: requiereHumano || l.requiere_humano });
      return;
    }

    let hits: KbHit[] = [];
    if (q?.pregunta) {
      try { hits = await kb.search(q.pregunta, { k: 3, idioma: facts.idioma }); } catch (err) {
        console.error("leads: búsqueda KB fallida", (err as Error).name);
      }
    }
    const complete = missing.length === 0;
    const conv = await llm.converse({
      system: buildConversationSystem({ missing, hits, complete, outOfHours }),
      messages: toMessageParams(turns),
    });
    let text: string;
    if (conv.ok) {
      text = conv.value;
    } else {
      text = FALLBACK_REPLY;
      requiereHumano = true;
      await kpi(db, "fallback_llm", msg, l.id);
    }
    const sent = await reply(msg, c, ingest.conversationId, l.id, text);
    if (!sent) requiereHumano = true;

    if (sent && l.estado === "nuevo") l = await saveLead(db, l, { estado: "respondido" });
    else if (l.estado === "respondido") l = await saveLead(db, l, { estado: "cualificando" });
    if (complete) l = (await qualifyAndAssign(l, facts, turns)).l;
    await saveLead(db, l, { requiere_humano: requiereHumano || l.requiere_humano });
  };
}
