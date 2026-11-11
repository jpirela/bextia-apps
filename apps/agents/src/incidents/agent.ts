import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { booking, incident, type BookingService } from "../db/schema.ts";
import type { Channel, ChannelAdapter, InboundMessage } from "../channels/types.ts";
import type { IngestResult } from "../gateway/ingest.ts";
import type { Turn } from "../leads/qualify.ts";
import type { Llm } from "../llm/types.ts";
import type { Mailer } from "../notify/mailer.ts";
import type { RouteDecision } from "../orchestrator/route.ts";
import type { KbHit, KnowledgeBase } from "../rag/kb.ts";
import type { Dispatch } from "../server/pipeline.ts";
import { toMessageParams } from "../leads/prompts.ts";
import { classifyIncident, decideRoute, detectEmergency } from "./classify.ts";
import { escalateIncidentResult, renotifyOnCall, type EscalationExtra } from "./escalate.ts";
import {
  ASK_NAME, EMERGENCY_REPLY, ESCALATED_REPLY, ESCALATED_WAIT, FEEDBACK_THANKS, IDENTIFIED_REPLY, NAME_MISMATCH,
  PROTOCOL_IN_PROGRESS, TEMPORARY_ERROR_REPLY, buildIncidentSystem, isNegativeFeedback, welcomeMessage,
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

// Guardarraíl de privacidad: al LLM (y a la búsqueda KB) no llegan email, teléfono, código de reserva,
// nombre del viajero ni nombre/referencia del proveedor, aunque aparezcan en el historial (los escribió
// el viajero o están en mensajes salientes de protocolos anteriores).
const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
// Secuencia de dígitos completa: no empieza ni acaba pegada a otro dígito ni dentro de una hora
// ("10:30"); un ":" que no esté entre dígitos ("Tel:600111222", "600111222: llámame") no la protege.
const PHONE_RE = /(?<!\d|\d:)\+?\d(?:[\s().-]?\d){6,16}(?!\d|:\d)/g;
// Forma de BOOKING_CODE, con y sin guion (BX-1001, BX1001).
const CODE_RE = /(?<![\p{L}\p{N}])[a-z]{2,4}-?\d{4,8}(?![\p{L}\p{N}])/giu;
const MIN_TOKEN = 3;
// Partículas de nombres compuestos: solas no identifican a nadie y son palabras comunes del texto.
const NAME_PARTICLES = new Set(["del", "las", "los", "dos", "das", "van", "von", "der", "den", "des", "die"]);
const ACCENTS: Record<string, string> = { a: "aáàâäã", e: "eéèêë", i: "iíìîï", o: "oóòôöõ", u: "uúùûü", n: "nñ", c: "cç" };

// Término literal con fronteras de palabra Unicode, insensible a mayúsculas y acentos.
function termRe(term: string): RegExp {
  const body = [...norm(term)].map((ch) =>
    ACCENTS[ch] ? `[${ACCENTS[ch]}]` : /\s/.test(ch) ? "\\s+" : ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
  ).join("");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

export function redactForLlm(text: string, b: { codigo: string; viajero_nombre?: string | null; servicios: unknown }): string {
  const servicios = (Array.isArray(b.servicios) ? b.servicios : []) as BookingService[];
  const long = (x: unknown): x is string => typeof x === "string" && x.trim().length >= MIN_TOKEN;
  // Primero email y teléfono: ningún reemplazo posterior puede partir una secuencia de dígitos.
  let out = text.replace(EMAIL_RE, "[email]");
  // Teléfono: con prefijo + o con al menos 9 dígitos (no tapa horas, fechas ni importes cortos).
  out = out.replace(PHONE_RE, (m) => (m.startsWith("+") || m.replace(/\D/g, "").length >= 9 ? "[telefono]" : m));
  out = out.replace(CODE_RE, "[reserva]");
  for (const c of [b.codigo, b.codigo.replace(/-/g, "")].filter(long)) out = out.replace(termRe(c.trim()), "[reserva]");
  for (const s of servicios) {
    if (long(s.proveedor)) out = out.replace(termRe(s.proveedor.trim()), "[proveedor]");
    if (long(s.referencia)) out = out.replace(termRe(s.referencia.trim()), "[referencia]");
  }
  for (const t of (b.viajero_nombre ?? "").split(/[^\p{L}]+/u)
    .filter((x) => x.length >= MIN_TOKEN && !NAME_PARTICLES.has(norm(x)))) {
    out = out.replace(termRe(t), "[nombre]");
  }
  return out;
}

// Al escalar por un fallo inesperado, el protocolo (si lo hay) queda terminado en la misma escritura.
const markTerminated: EscalationExtra = (c) =>
  c.protocolo_estado ? { protocolo_estado: { ...c.protocolo_estado, terminado: true } } : {};

// Lo que el manejador sabe en cada momento, para que la recuperación no deje nada colgado.
interface Progress { incidentId: string | null; target: TravelerTarget | null; conversationId: string; channel: Channel }

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
      const { row, escalated } = await escalateIncidentResult(rd, inc, "emergencia", (c) => ({
        ...markTerminated(c), tipologia: "emergencia", urgencia: "critica",
      }));
      // Ya estaba escalada (p. ej. por llm_fallido): se marca la emergencia y se vuelve a avisar a la
      // guardia, porque EMERGENCY_REPLY le promete al viajero que el equipo ya está avisado.
      if (!escalated && row.estado === "escalado") {
        const tagged = await saveIncident(db, row, { tipologia: "emergencia", urgencia: "critica", requiere_humano: true }, now());
        await renotifyOnCall(rd, tagged, "emergencia");
      }
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
  // Primero se escala y solo después se avisa: el aviso sale únicamente si ESTA llamada escaló (o si,
  // fallido el escalado, quedó marcado requiere_humano), así una carrera no produce avisos dobles.
  async function recover(p: Progress, err: Error): Promise<void> {
    const alert = (fase: string) => recordKpi(db, "error_agente", {
      ref_id: p.incidentId ?? p.conversationId, canal: p.channel, datos: { fase, error: err.name },
    }).catch((e: Error) => console.error("incidencias: KPI de error fallido", e.name));
    const sendRaw = async (text: string) => {
      if (!p.target) return;
      try {
        await deps.send({ channel: p.target.channel, to: p.target.to, text, subject: p.target.subject });
      } catch (e) {
        console.error("incidencias: aviso de error fallido", (e as Error).name);
      }
    };
    try {
      if (!p.incidentId) {
        // Sin incidencia no hay a quién escalar: no se promete una persona; se pide reintentar.
        await alert("sin_incidencia");
        await sendRaw(TEMPORARY_ERROR_REPLY);
        return;
      }
      await alert("con_incidencia");
      const [fresh] = await db.select().from(incident).where(eq(incident.id, p.incidentId));
      if (!fresh || fresh.estado === "escalado" || fresh.estado === "cerrado") return;
      let handedOff: boolean;
      try {
        handedOff = (await escalateIncidentResult(rd, fresh, "error_interno", markTerminated)).escalated;
      } catch (e) {
        console.error("incidencias: escalado de recuperación fallido", (e as Error).name);
        await db.update(incident).set({ requiere_humano: true }).where(eq(incident.id, fresh.id));
        handedOff = true;
      }
      if (!handedOff) return;
      const t = p.target ?? (await targetFromIncident(db, fresh));
      if (t) await sendTraveler(rd, t, fresh.id, ESCALATED_REPLY);
    } catch (e) {
      console.error("incidencias: recuperación fallida", (e as Error).name);
    }
  }

  return async ({ msg, ingest, decision }) => {
    if (decision.agent !== "incidents" || !decision.bookingId) return;
    const progress: Progress = { incidentId: null, target: null, conversationId: ingest.conversationId, channel: msg.channel };
    try {
      await handle(msg, ingest, { ...decision, bookingId: decision.bookingId }, progress);
    } catch (err) {
      console.error("incidencias: fallo del agente", (err as Error).name);
      await recover(progress, err as Error);
    }
  };
}
