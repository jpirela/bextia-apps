import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./test-db.ts";
import { contact, conversation, message } from "./schema.ts";
import type { Db } from "./index.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

describe("migraciones", () => {
  it("rechaza un mensaje repetido por canal + external_id", async () => {
    const [c] = await db.insert(contact).values({ nombre: "Ana", telefono: "+34600000001" }).returning();
    const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "whatsapp" }).returning();
    const row = {
      conversation_id: conv.id, canal: "whatsapp", direccion: "in", contenido: "hola", external_id: "wamid.1",
    } as const;
    const first = await db.insert(message).values(row).onConflictDoNothing().returning();
    const second = await db.insert(message).values(row).onConflictDoNothing().returning();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
