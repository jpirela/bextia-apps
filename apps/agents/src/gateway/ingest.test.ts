import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import { eq } from "drizzle-orm";
import { contact, conversation, message } from "../db/schema.ts";
import { isUniqueViolation } from "../db/errors.ts";
import type { Db } from "../db/index.ts";
import type { InboundMessage } from "../channels/types.ts";
import { completeContact, ingest } from "./ingest.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const msg = (externalId: string, text = "hola"): InboundMessage => ({
  channel: "whatsapp", externalId, from: { phone: "+34600000001", name: "Ana" }, text,
  receivedAt: new Date("2026-11-09T22:00:00Z"),
});

describe("ingest", () => {
  it("reutiliza un contacto existente solo por email cuando el mensaje trae email y teléfono", async () => {
    const [existing] = await db.insert(contact).values({ email: "ana@x.com" }).returning();
    const r = await ingest(db, { ...msg("wamid.9"), from: { phone: "+34600000009", email: "ana@x.com" } });
    expect(r.contact.id).toBe(existing.id);
    expect(await db.select().from(contact)).toHaveLength(1);
  });

  it("crea contacto, conversación y mensaje", async () => {
    const r = await ingest(db, msg("wamid.1"));
    expect(r.duplicate).toBe(false);
    expect(r.contact.telefono).toBe("+34600000001");
    expect(r.contact.nombre).toBe("Ana");
    expect(r.messageId).not.toBeNull();
  });

  it("es idempotente por external_id", async () => {
    await ingest(db, msg("wamid.1"));
    const again = await ingest(db, msg("wamid.1"));
    expect(again.duplicate).toBe(true);
    expect(await db.select().from(message)).toHaveLength(1);
  });

  it("reutiliza contacto y conversación abierta", async () => {
    const a = await ingest(db, msg("wamid.1"));
    const b = await ingest(db, msg("wamid.2", "segundo"));
    expect(b.contact.id).toBe(a.contact.id);
    expect(b.conversationId).toBe(a.conversationId);
    expect(await db.select().from(contact)).toHaveLength(1);
  });

  it("rechaza un mensaje sin teléfono ni email", async () => {
    await expect(ingest(db, { ...msg("wamid.9"), from: { name: "Anónimo" } }))
      .rejects.toThrow("Mensaje sin identificador de contacto");
    await expect(ingest(db, { ...msg("wamid.10"), from: { phone: "", email: "" } }))
      .rejects.toThrow("Mensaje sin identificador de contacto");
  });

  it("guarda null, nunca cadena vacía, en el campo que falta", async () => {
    const r = await ingest(db, { ...msg("wamid.11"), from: { phone: "+34600000005", email: "" } });
    expect(r.contact.telefono).toBe("+34600000005");
    expect(r.contact.email).toBeNull();
  });
});

describe("agente1: conversación única y contacto completo", () => {
  const base = (externalId: string, from: InboundMessage["from"]): InboundMessage => ({
    channel: "sim", externalId, from, text: "hola", receivedAt: new Date("2026-11-09T22:00:00Z"),
  });

  it("dos mensajes simultáneos de un contacto nuevo comparten conversación (P9)", async () => {
    const [a, b] = await Promise.all([
      ingest(db, base("x-1", { email: "luz@example.com" })),
      ingest(db, base("x-2", { email: "luz@example.com" })),
    ]);
    expect(a.conversationId).toBe(b.conversationId);
    expect(await db.select().from(conversation)).toHaveLength(1);
  });

  it("la BD rechaza una segunda conversación abierta del mismo contacto y canal", async () => {
    const r = await ingest(db, base("x-1", { email: "luz@example.com" }));
    const err = await db.insert(conversation).values({ contact_id: r.contact.id, canal: "sim" }).then(() => null, (e) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("completa el email de un contacto encontrado por teléfono (P10)", async () => {
    await ingest(db, base("x-1", { phone: "+34600111222" }));
    const r = await ingest(db, base("x-2", { phone: "+34600111222", email: "luz@example.com", name: "Luz" }));
    expect(r.contact).toMatchObject({ telefono: "+34600111222", email: "luz@example.com", nombre: "Luz" });
  });

  it("no falla si el email ya pertenece a otro contacto", async () => {
    await ingest(db, base("x-1", { email: "otro@example.com" }));
    const r1 = await ingest(db, base("x-2", { phone: "+34600111222" }));
    const updated = await completeContact(db, r1.contact, { email: "otro@example.com" });
    expect(updated.email).toBeNull();
    const [row] = await db.select().from(contact).where(eq(contact.id, r1.contact.id));
    expect(row.email).toBeNull();
  });
});