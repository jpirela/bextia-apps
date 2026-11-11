import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { booking, incident, type BookingService } from "../db/schema.ts";
import type { ChannelAdapter, InboundMessage } from "../channels/types.ts";
import type { IngestResult } from "../gateway/ingest.ts";
import type { Turn } from "../leads/qualify.ts";
import type { Llm } from "../llm/types.ts";
import type { Mailer } from "../notify/mailer.ts";
import { BOOKING_CODE, type RouteDecision } from "../orchestrator/route.ts";
import type { KbHit, KnowledgeBase } from "../rag/kb.ts";
import type { Dispatch } from "../server/pipeline.ts";
import { toMessageParams } from "../leads/prompts.ts";
import { classifyIncident, decideRoute, detectEmergency } from "./classify.ts";
import { escalateIncidentResult, type EscalationExtra } from "./escalate.ts";
import {
  ASK_NAME, EMERGENCY_REPLY, ESCALATED_REPLY, ESCALATED_WAIT, FEEDBACK_THANKS, IDENTIFIED_REPLY, NAME_MISMATCH,
  PROTOCOL_IN_PROGRESS, buildIncidentSystem, isNegativeFeedback, welcomeMessage,
} from "./prompts.ts";
import { parseProviderReply, type ProviderChannels } from "./provider.ts";
import { loadHistory, sendTraveler, targetFromIncident, targetFromInbound, type TravelerTarget } from "./reply.ts";
import { escalateWithNotice, runProtocol, startProtocol, type RunnerDeps } from "./runner.ts";
import { INACTIVITY_MS, claimWait, findOrCreateIncident, logAction, recordKpi, saveIncident } from "./store.ts";

export interface IncidentsAgentDeps {
  db: Db;
  llm: Llm;
  kb: KnowledgeBase;
  send: ChannelAdapter["send"];
  mailer: Mailer | null;
  providerChannels: ProviderChannels;
  backofficeUrl?: string | null;
  now?: () => Date;
}

const MAX_ID_ATTEMPTS = 3;
const FEEDBACK_MAX = 1000;
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function surnameMatches(fullName: string, text: string): boolean {
  const surnames = norm(fullName).split(/[^a-z]+/).filter(Boolean).slice(1).filter((t) => t.length >= 3);
  const words = new Set(norm(text).split(/[^a-z]+/).filter(Boolean));
  return surnames.some((s) => words.has(s));
}

// Guardarraíl de privacidad: al LLM (y a la búsqueda KB) no llegan email, teléfono, código de reserva
// ni nombre/referencia del proveedor, aunque aparezcan en el historial (los escribió el viajero o
// están en mensajes salientes de protocolos anteriores).
const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
const PHONE_RE = /\+?\d(?:[\s().-]?\d){6,16}/g;
const CODE_RE = new RegExp(BOOKING_CODE.source, "gi");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactForLlm(text: string, b: { codigo: string; servicios: unknown }): string {
  const servicios = (Array.isArray(b.servicios) ? b.servicios : []) as BookingService[];
  const names = [b.codigo, ...servicios.flatMap((s) => [s.proveedor, s.referencia])]
    .filter((x): x is string => typeof x === "string" && x.trim().length >= 2);
  let out = text.replace(EMAIL_RE, "[email]");
  for (const n of names) out = out.replace(new RegExp(escapeRe(n.trim()), "gi"), "[dato]");
  out = out.replace(CODE_RE, "[reserva]");
  // Teléfono: con prefijo + o al menos 9 dígitos (no tapa horas ni importes cortos).
  return out.replace(PHONE_RE, (m) => (m.startsWith("+") || m.replace(/\D/g, "").length >= 9 ? "[telefono]" : m));
}

// Al escalar por un fallo inesperado, el protocolo (si lo hay) queda terminado en la misma escritura.
const markTerminated: EscalationExtra = (c) =>
  c.protocolo_estado ? { protocolo_estado: { ...c.protocolo_estado, terminado: true } } : {};

// Lo que el manejador sabe en cada momento, para que la recuperación no deje nada colgado.
interface Progress { incidentId: string | null; target: TravelerTarget | null }

export function createIncidentsAgent(deps: IncidentsAgentDeps): Dispatch {
  const now = deps.now ?? (() => new Date());
  const rd: RunnerDeps = {
    db: deps.db, send: deps.send, now, mailer: deps.mailer, backofficeUrl: deps.backofficeUrl, providerChannels: deps.providerChannels,
  };
  const { db } = deps;

  async function onProviderReply(incidentId: string, text: string): Promise<void> {
    const reply = await parseProviderReply(deps.llm, text);
    await logAction(db, incidentId, "mensaje_proveedor", { direccion: "in", lectura: reply.tipo });
    if (reply.tipo === "desconocido") return;
    // Solo quien reclama la espera avanza el protocolo: una respuesta duplicada o tardía no tiene efectos.
    if (!(await claimWait(db, incidentId))) return;
    const [inc] = await db.select().from(incident).where(eq(incident.id, incidentId));
    if (!inc) return;
    await runProtocol(rd, inc, { tipo: "respuesta_proveedor", eta_min: reply.tipo === "eta" ? reply.minutos : null });
  }

  async function handle(
    msg: InboundMessage, ing: IngestResult, decision: RouteDecision & { bookingId: string }, p: Progress,
  ): Promise<void> {
    if (decision.providerIncidentId) {
      p.incidentId = decision.providerIncidentId; // el viajero se resuelve desde la incidencia si hay que recuperar
      return onProviderReply(decision.providerIncidentId, msg.text);
    }

    const t = targetFromInbound(msg, ing.conversationId);
    p.target = t;
    let inc = await findOrCreateIncident(db, {
      bookingId: decision.bookingId, conversationId: ing.conversationId, contactId: ing.contact.id, now: now(),
    });
    p.incidentId = inc.id;
    const say = (text: string) => sendTraveler(rd, t, inc.id, text, msg.receivedAt);

    // Emergencia: antes de cualquier LLM e incluso sin identificar. EMERGENCY_REPLY sustituye al aviso de escalado.
    if (detectEmergency(msg.text)) {
      await say(EMERGENCY_REPLY);
      await escalateIncidentResult(rd, inc, "emergencia", (c) => ({
        ...markTerminated(c), tipologia: "emergencia", urgencia: "critica",
      }));
      return;
    }
    if (inc.estado === "escalado") { await say(ESCALATED_WAIT); return; }

    const [b] = await db.select().from(booking).where(eq(booking.id, inc.booking_id));
    if (!b) { await escalateWithNotice(rd, inc, "sin_reserva", t); return; }

    if (inc.estado === "identificando") {
      const bySurname = !decision.verified;
      if (bySurname && !surnameMatches(b.viajero_nombre, msg.text)) {
        const intentos = inc.intentos_identificacion + 1;
        inc = await saveIncident(db, inc, { intentos_identificacion: intentos }, now());
        if (intentos >= MAX_ID_ATTEMPTS) { await escalateWithNotice(rd, inc, "identificacion_fallida", t); return; }
        await say(intentos === 1 ? ASK_NAME : NAME_MISMATCH);
        return;
      }
      await logAction(db, inc.id, "identificacion", { metodo: bySurname ? "apellido" : "contacto" });
      await db.update(booking).set({ contact_id: ing.contact.id }).where(and(eq(booking.id, b.id), isNull(booking.contact_id)));
      const welcomed = await db.update(booking).set({ bienvenida_at: now() })
        .where(and(eq(booking.id, b.id), isNull(booking.bienvenida_at))).returning({ id: booking.id });
      if (welcomed.length > 0) await say(welcomeMessage(b));
      inc = await saveIncident(db, inc, { estado: "bienvenida" }, now());
      if (bySurname) {
        if (welcomed.length === 0) await say(IDENTIFIED_REPLY);
        return; // el mensaje era el apellido: no hay nada que clasificar
      }
    }

    if (inc.estado === "protocolo") { await say(PROTOCOL_IN_PROGRESS); return; }

    if (inc.estado === "seguimiento") {
      const negativo = isNegativeFeedback(msg.text);
      inc = await saveIncident(db, inc, { feedback: msg.text.slice(0, FEEDBACK_MAX) }, now());
      await logAction(db, inc.id, "feedback", { negativo });
      if (negativo) { await escalateWithNotice(rd, inc, "feedback_negativo", t); return; }
      await say(FEEDBACK_THANKS);
      await saveIncident(db, inc, { estado: "cerrado", proximo_paso_at: null }, now());
      return;
    }

    // bienvenida | clasificando | conversacional
    const history: Turn[] = (await loadHistory(db, ing.conversationId))
      .map((h) => ({ ...h, contenido: redactForLlm(h.contenido, b) }));
    const cls = await classifyIncident(deps.llm, history);
    inc = await saveIncident(db, inc, cls
      ? { estado: "clasificando", tipologia: cls.tipologia, urgencia: cls.urgencia, resumen_ia: cls.resumen.slice(0, 500) }
      : { estado: "clasificando" }, now());
    if (cls) {
      await recordKpi(db, "incidencia_clasificada", {
        ref_id: inc.id, canal: msg.channel, datos: { tipologia: cls.tipologia, urgencia: cls.urgencia },
      });
    }

    // La emergencia ya se descartó arriba (detectEmergency), antes del LLM.
    const r = decideRoute(cls, false);
    if (r.kind === "protocolo") { await startProtocol(rd, inc, r.codigo, t); return; }
    if (r.kind === "escalado") { await escalateWithNotice(rd, inc, r.motivo, t); return; }

    let hits: KbHit[] = [];
    try {
      hits = await deps.kb.search(redactForLlm(msg.text, b), { k: 3, idioma: cls?.idioma ?? null });
    } catch (err) {
      console.error("incidencias: búsqueda KB fallida", (err as Error).name);
    }
    const reply = await deps.llm.converse({ system: buildIncidentSystem(hits, b.destino), messages: toMessageParams(history) });
    if (!reply.ok || !reply.value.trim()) { await escalateWithNotice(rd, inc, "llm_fallido", t); return; }
    await say(reply.value);
    await saveIncident(db, inc, { estado: "conversacional", proximo_paso_at: new Date(now().getTime() + INACTIVITY_MS) }, now());
  }

  // Ante un error inesperado nada queda colgado (incluida una incidencia en "protocolo" sin temporizador
  // porque runProtocol lanzó tras el commit de startProtocol): aviso al viajero, escalado y, si el
  // escalado también falla, requiere_humano. Solo se registra err.name.
  async function recover(p: Progress): Promise<void> {
    try {
      if (!p.incidentId) {
        if (p.target) {
          await deps.send({ channel: p.target.channel, to: p.target.to, text: ESCALATED_REPLY, subject: p.target.subject });
        }
        return;
      }
      const [fresh] = await db.select().from(incident).where(eq(incident.id, p.incidentId));
      if (!fresh || fresh.estado === "escalado" || fresh.estado === "cerrado") return;
      const t = p.target ?? (await targetFromIncident(db, fresh));
      if (t) await sendTraveler(rd, t, fresh.id, ESCALATED_REPLY);
      try {
        await escalateIncidentResult(rd, fresh, "error_interno", markTerminated);
      } catch (err) {
        console.error("incidencias: escalado de recuperación fallido", (err as Error).name);
        await db.update(incident).set({ requiere_humano: true }).where(eq(incident.id, fresh.id));
      }
    } catch (err) {
      console.error("incidencias: recuperación fallida", (err as Error).name);
    }
  }

  return async ({ msg, ingest, decision }) => {
    if (decision.agent !== "incidents" || !decision.bookingId) return;
    const progress: Progress = { incidentId: null, target: null };
    try {
      await handle(msg, ingest, { ...decision, bookingId: decision.bookingId }, progress);
    } catch (err) {
      console.error("incidencias: fallo del agente", (err as Error).name);
      await recover(progress);
    }
  };
}
