import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { contact, conversation, message } from "../db/schema.ts";
import type { Channel, ChannelAdapter, InboundMessage } from "../channels/types.ts";
import type { Turn } from "../leads/qualify.ts";
import type { ProviderTarget } from "./provider.ts";
import { logAction, recordKpi, type IncidentRow } from "./store.ts";

export interface AgentIo { db: Db; send: ChannelAdapter["send"]; now: () => Date }
export interface TravelerTarget { channel: Channel; to: { phone?: string; email?: string }; subject?: string; conversationId: string }

const EMAIL_SUBJECT = "BEXTIA · Asistencia en viaje";
const subjectFor = (ch: Channel) => (ch === "email" ? EMAIL_SUBJECT : undefined);

export function targetFromInbound(msg: InboundMessage, conversationId: string): TravelerTarget {
  return { channel: msg.channel, to: { email: msg.from.email, phone: msg.from.phone }, subject: subjectFor(msg.channel), conversationId };
}

// Para mensajes que no responden a un entrante (temporizadores, SLA).
export async function targetFromIncident(db: Db, inc: IncidentRow): Promise<TravelerTarget | null> {
  if (!inc.conversation_id) return null;
  const [row] = await db.select({ canal: conversation.canal, email: contact.email, telefono: contact.telefono })
    .from(conversation).innerJoin(contact, eq(contact.id, conversation.contact_id))
    .where(eq(conversation.id, inc.conversation_id));
  if (!row) return null;
  return {
    channel: row.canal,
    to: { email: row.email ?? undefined, phone: row.telefono ?? undefined },
    subject: subjectFor(row.canal),
    conversationId: inc.conversation_id,
  };
}

// El envío y la traza se separan: si el canal ya entregó, un fallo al guardar la traza
// no debe devolver false (provocaría un reenvío duplicado).
async function trace(fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (err) { console.error("incidencias: traza de envío fallida", (err as Error).name); }
}

export async function sendTraveler(io: AgentIo, t: TravelerTarget, incidentId: string, text: string, receivedAt?: Date): Promise<boolean> {
  let externalId: string;
  try {
    ({ externalId } = await io.send({ channel: t.channel, to: t.to, text, subject: t.subject }));
  } catch (err) {
    console.error("incidencias: envío al viajero fallido", (err as Error).name);
    await trace(() => recordKpi(io.db, "envio_fallido", { ref_id: incidentId, canal: t.channel, datos: { destino: "viajero" } }));
    return false;
  }
  const at = io.now();
  await trace(async () => {
    await io.db.insert(message).values({
      conversation_id: t.conversationId, canal: t.channel, direccion: "out", contenido: text,
      external_id: externalId || `out-${randomUUID()}`, agente: "incidents", created_at: at,
    });
  });
  await trace(() => logAction(io.db, incidentId, "mensaje_viajero", { canal: t.channel, texto: text }));
  await trace(() => recordKpi(io.db, "respuesta_enviada", {
    ref_id: incidentId, canal: t.channel, valor: receivedAt ? at.getTime() - receivedAt.getTime() : undefined,
  }));
  return true;
}

export async function sendProvider(io: AgentIo, t: ProviderTarget, incidentId: string, text: string): Promise<boolean> {
  try {
    await io.send({ channel: t.channel, to: t.to, text, subject: subjectFor(t.channel) });
  } catch (err) {
    console.error("incidencias: envío al proveedor fallido", (err as Error).name);
    await trace(() => recordKpi(io.db, "envio_fallido", { ref_id: incidentId, canal: t.channel, datos: { destino: "proveedor" } }));
    return false;
  }
  await trace(() => logAction(io.db, incidentId, "mensaje_proveedor", { canal: t.channel, direccion: "out", texto: text }));
  return true;
}

export async function loadHistory(db: Db, conversationId: string): Promise<Turn[]> {
  const rows = await db.select({ direccion: message.direccion, contenido: message.contenido }).from(message)
    .where(eq(message.conversation_id, conversationId)).orderBy(desc(message.created_at), desc(message.id)).limit(30);
  return rows.reverse() as Turn[];
}
