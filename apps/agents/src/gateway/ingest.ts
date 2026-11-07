import { and, desc, eq, or, type SQL } from "drizzle-orm";
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
  const conds: SQL[] = [];
  if (from.phone) conds.push(eq(contact.telefono, from.phone));
  if (from.email) conds.push(eq(contact.email, from.email));
  if (conds.length === 0) return undefined;
  const rows = await db.select().from(contact).where(or(...conds)).limit(2);
  // Si coinciden dos filas (una por teléfono, otra por email), se prefiere la del teléfono.
  return rows.find((r) => from.phone && r.telefono === from.phone) ?? rows[0];
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
  if (created) return created;
  const again = await findContact(db, msg.from);
  if (!again) throw new Error("ingest: no se pudo crear ni encontrar el contacto");
  return again;
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
