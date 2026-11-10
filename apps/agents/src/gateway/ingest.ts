import { and, desc, eq, or, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { isUniqueViolation } from "../db/errors.ts";
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

// Completa teléfono/email/nombre que falten. Si el dato ya pertenece a otro contacto (unique), se deja como está.
export async function completeContact(
  db: Db,
  c: ContactRow,
  from: { phone?: string | null; email?: string | null; name?: string | null },
): Promise<ContactRow> {
  const patch: Partial<typeof contact.$inferInsert> = {};
  if (!c.telefono && from.phone) patch.telefono = from.phone;
  if (!c.email && from.email) patch.email = from.email.toLowerCase();
  if (!c.nombre && from.name) patch.nombre = from.name;
  if (Object.keys(patch).length === 0) return c;
  try {
    const [updated] = await db.update(contact).set(patch).where(eq(contact.id, c.id)).returning();
    return updated ?? c;
  } catch (err) {
    if (isUniqueViolation(err)) return c;
    throw err;
  }
}

async function upsertContact(db: Db, msg: InboundMessage): Promise<ContactRow> {
  if (!msg.from.phone && !msg.from.email) throw new MissingContactError();
  const found = await findContact(db, msg.from);
  if (found) return completeContact(db, found, msg.from);
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

async function findOpenConversation(db: Db, contactId: string, canal: Channel): Promise<string | undefined> {
  const [open] = await db.select({ id: conversation.id }).from(conversation)
    .where(and(eq(conversation.contact_id, contactId), eq(conversation.canal, canal), eq(conversation.estado, "abierta")))
    .orderBy(desc(conversation.created_at)).limit(1);
  return open?.id;
}

async function openConversation(db: Db, contactId: string, canal: Channel): Promise<string> {
  const existing = await findOpenConversation(db, contactId, canal);
  if (existing) return existing;
  // ON CONFLICT DO NOTHING sin target cubre el índice único parcial conversation_abierta_unica.
  const [created] = await db.insert(conversation).values({ contact_id: contactId, canal })
    .onConflictDoNothing().returning({ id: conversation.id });
  if (created) return created.id;
  const again = await findOpenConversation(db, contactId, canal);
  if (!again) throw new Error("ingest: no se pudo abrir la conversación");
  return again;
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
