import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import { contact, message } from "../db/schema.ts";
import type { Db } from "../db/index.ts";
import type { InboundMessage } from "../channels/types.ts";
import { ingest } from "./ingest.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const msg = (externalId: string, text = "hola"): InboundMessage => ({
  channel: "whatsapp", externalId, from: { phone: "+34600000001", name: "Ana" }, text,
  receivedAt: new Date("2026-11-09T22:00:00Z"),
});

describe("ingest", () => {
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
});
