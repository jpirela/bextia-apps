import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { contact, conversation, lead } from "../db/schema.ts";
import { canTransition, findOrCreateLead, InvalidTransitionError, saveLead } from "./store.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

async function convo() {
  const [c] = await db.insert(contact).values({ email: "luz@example.com" }).returning();
  const [cv] = await db.insert(conversation).values({ contact_id: c.id, canal: "sim" }).returning();
  return { contactId: c.id, conversationId: cv.id, mercado: "ES", fueraDeHorario: true };
}

describe("lead store", () => {
  it("transiciones", () => {
    expect(canTransition("nuevo", "respondido")).toBe(true);
    expect(canTransition("nuevo", "cualificado")).toBe(true);
    expect(canTransition("respondido", "cualificando")).toBe(true);
    expect(canTransition("cualificado", "asignado")).toBe(true);
    expect(canTransition("asignado", "entregado")).toBe(true);
    expect(canTransition("entregado", "nuevo")).toBe(false);
    expect(canTransition("nuevo", "entregado")).toBe(false);
    expect(canTransition("asignado", "asignado")).toBe(true);
  });

  it("un lead por conversación, aun en paralelo", async () => {
    const input = await convo();
    const [a, b] = await Promise.all([findOrCreateLead(db, input), findOrCreateLead(db, input)]);
    expect(a.lead.id).toBe(b.lead.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(lead)).toHaveLength(1);
    expect(a.lead).toMatchObject({ estado: "nuevo", mercado: "ES", fuera_de_horario: true });
  });

  it("saveLead aplica el patch y rechaza transiciones inválidas", async () => {
    const { lead: l } = await findOrCreateLead(db, await convo());
    const r = await saveLead(db, l, { estado: "respondido", destino: "Japón" });
    expect(r).toMatchObject({ estado: "respondido", destino: "Japón" });
    await expect(saveLead(db, r, { estado: "entregado" })).rejects.toThrow(InvalidTransitionError);
  });
});