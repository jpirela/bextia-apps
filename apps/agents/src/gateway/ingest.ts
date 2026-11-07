import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { contact, conversation, message } from "../db/schema.ts";
import type { Channel, InboundMessage } from "../channels/types.ts";
import { MissingContactError } from "../channels/errors.ts";

export type ContactRow = typeof contact.$inferSelect;

export interface IngestResult {
  duplicate: boolean;
  contact: ContactRow;
  conversationId: string;
  messageId: string | null;
}

async function findContact(db: Db, from: InboundMessage["from"]): Promise<ContactRow | undefined> {
  const where = from.phone ? eq(contact.telefono, from.phone) : eq(contact.email, from.email ?? "");
  const [row] = await db.select().from(contact).where(where).limit(1);
  return row;
}

async function upsertContact(db: Db, msg: InboundMessage): Promise<ContactRow> {
  if (!msg.from.phone && !msg.from.email) throw new MissingContactError();
  const found = await findContact(db, msg.from);
  if (found) return found;
  const [created] = await db.insert(contact).values({
    nombre: msg.from.name ?? null,
    telefono: msg.from.phone || null,
    email: msg.from.email || null,
    mercado: msg.market ?? null,
    canal_preferido: msg.channel,
  }).onConflictDoNothing().returning();
  // Carrera: otro request lo creó entre el select y el insert.
  return created ?? (await findContact(db, msg.from))!;
}

async function openConversation(db: Db, contactId: string, canal: Channel): Promise<string> {
  const [open] = await db.select({ id: conversation.id }).from(conversation)
    .where(and(eq(conversation.contact_id, contactId), eq(conversation.canal, canal), eq(conversation.estado, "abierta")))
    .orderBy(desc(conversation.created_at)).limit(1);
  if (open) return open.id;
  const [created] = await db.insert(conversation).values({ contact_id: contactId, canal }).returning({ id: conversation.id });
  return created.id;
}

export async function ingest(db: Db, msg: InboundMessage): Promise<IngestResult> {
  const c = await upsertContact(db, msg);
  const conversationId = await openConversation(db, c.id, msg.channel);
  const inserted = await db.insert(message).values({
    conversation_id: conversationId,
    canal: msg.channel,
    direccion: "in",
    contenido: msg.text,
    external_id: msg.externalId,
    created_at: msg.receivedAt,
  }).onConflictDoNothing({ target: [message.canal, message.external_id] }).returning({ id: message.id });
  return { duplicate: inserted.length === 0, contact: c, conversationId, messageId: inserted[0]?.id ?? null };
}
