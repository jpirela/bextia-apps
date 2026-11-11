import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, contact, conversation, incident, incident_action, kpi_event, message } from "../db/schema.ts";
import type { OutboundMessage } from "../channels/types.ts";
import { loadHistory, sendProvider, sendTraveler, targetFromIncident, targetFromInbound } from "./reply.ts";
import { buildIncidentSystem, isNegativeFeedback, welcomeMessage } from "./prompts.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const now = new Date("2026-11-08T10:05:00Z");

async function seed() {
  const [c] = await db.insert(contact).values({ email: "ana@example.com", telefono: "+34600000001" }).returning();
  const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "sim" }).returning();
  const [b] = await db.insert(booking).values({
    codigo: "BX-1001", viajero_nombre: "Ana García", destino: "Lisboa",
    inicio: new Date("2026-11-07T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
  }).returning();
  const [inc] = await db.insert(incident).values({ booking_id: b.id, conversation_id: conv.id, contact_id: c.id }).returning();
  return { c, conv, inc };
}

describe("reply", () => {
  it("sendTraveler envía, guarda el mensaje, la acción y el KPI con la latencia", async () => {
    const { conv, inc } = await seed();
    const sent: OutboundMessage[] = [];
    const io = { db, now: () => now, send: async (m: OutboundMessage) => { sent.push(m); return { externalId: "x-1" }; } };
    const t = { channel: "sim" as const, to: { email: "ana@example.com" }, conversationId: conv.id };
    expect(await sendTraveler(io, t, inc.id, "Hola", new Date(now.getTime() - 2000))).toBe(true);
    expect(sent).toEqual([{ channel: "sim", to: { email: "ana@example.com" }, text: "Hola", subject: undefined }]);
    expect(await db.select().from(message)).toMatchObject([{ direccion: "out", contenido: "Hola", external_id: "x-1", agente: "incidents" }]);
    expect(await db.select().from(incident_action)).toMatchObject([{ tipo: "mensaje_viajero" }]);
    expect(await db.select().from(kpi_event)).toMatchObject([{ tipo: "respuesta_enviada", agente: "incidents", valor: 2000 }]);
  });

  it("si el canal falla devuelve false y registra envio_fallido sin lanzar", async () => {
    const { conv, inc } = await seed();
    const io = { db, now: () => now, send: async () => { throw new Error("caído"); } };
    const t = { channel: "sim" as const, to: {}, conversationId: conv.id };
    expect(await sendTraveler(io, t, inc.id, "Hola")).toBe(false);
    expect(await db.select().from(message)).toHaveLength(0);
    expect(await db.select().from(kpi_event)).toMatchObject([{ tipo: "envio_fallido" }]);
  });

  it("sendProvider registra mensaje_proveedor con canal y dirección", async () => {
    const { inc } = await seed();
    const sent: OutboundMessage[] = [];
    const io = { db, now: () => now, send: async (m: OutboundMessage) => { sent.push(m); return { externalId: "" }; } };
    expect(await sendProvider(io, { channel: "sim", to: { email: "ops@translis.test" }, contacto: "ops@translis.test" }, inc.id, "¿ETA?")).toBe(true);
    expect(sent[0]).toMatchObject({ channel: "sim", to: { email: "ops@translis.test" }, text: "¿ETA?" });
    expect(await db.select().from(incident_action)).toMatchObject([{ tipo: "mensaje_proveedor", detalle: { canal: "sim", direccion: "out" } }]);
  });

  it("targets: desde el mensaje entrante y desde la incidencia", async () => {
    const { conv, inc } = await seed();
    const msg = { channel: "email" as const, externalId: "e", from: { email: "ana@example.com" }, text: "x", receivedAt: now };
    expect(targetFromInbound(msg, conv.id)).toEqual({
      channel: "email", to: { email: "ana@example.com", phone: undefined }, subject: "BEXTIA · Asistencia en viaje", conversationId: conv.id,
    });
    expect(await targetFromIncident(db, inc)).toEqual({
      channel: "sim", to: { email: "ana@example.com", phone: "+34600000001" }, subject: undefined, conversationId: conv.id,
    });
  });

  it("si el canal entregó y la traza en BD falla, devuelve true y no reenvía", async () => {
    const { conv, inc } = await seed();
    let calls = 0;
    const failingDb = new Proxy(db, { get: (o, p) => (p === "insert" ? () => { throw new Error("bd caída"); } : Reflect.get(o, p)) }) as Db;
    const io = { db: failingDb, now: () => now, send: async () => { calls++; return { externalId: "x-9" }; } };
    const t = { channel: "sim" as const, to: {}, conversationId: conv.id };
    expect(await sendTraveler(io, t, inc.id, "Hola")).toBe(true);
    expect(calls).toBe(1);
  });

  it("loadHistory desempata de forma estable mensajes con el mismo timestamp", async () => {
    const { conv } = await seed();
    const at = new Date("2026-11-08T10:00:00Z");
    await db.insert(message).values([
      { conversation_id: conv.id, canal: "sim", direccion: "out", contenido: "a", external_id: "a", created_at: at },
      { conversation_id: conv.id, canal: "sim", direccion: "out", contenido: "b", external_id: "b", created_at: at },
    ]);
    const first = await loadHistory(db, conv.id);
    expect(first).toHaveLength(2);
    expect(await loadHistory(db, conv.id)).toEqual(first);
  });

  it("loadHistory devuelve los turnos en orden cronológico", async () => {
    const { conv } = await seed();
    await db.insert(message).values([
      { conversation_id: conv.id, canal: "sim", direccion: "in", contenido: "uno", external_id: "1", created_at: new Date("2026-11-08T10:00:00Z") },
      { conversation_id: conv.id, canal: "sim", direccion: "out", contenido: "dos", external_id: "2", created_at: new Date("2026-11-08T10:01:00Z") },
    ]);
    expect(await loadHistory(db, conv.id)).toEqual([{ direccion: "in", contenido: "uno" }, { direccion: "out", contenido: "dos" }]);
  });
});

describe("prompts", () => {
  it("bienvenida con el primer nombre y el destino", () => {
    expect(welcomeMessage({ viajero_nombre: "Ana García", destino: "Lisboa" })).toContain("Ana");
    expect(welcomeMessage({ viajero_nombre: "Ana García", destino: "Lisboa" })).toContain("Lisboa");
  });

  it("system prompt con artículos KB y sin datos de contacto", () => {
    const s = buildIncidentSystem([{ id: "1", titulo: "Check-in", contenido: "A partir de las 15:00.", similarity: 0.9 }], "Lisboa");
    expect(s).toContain("Check-in");
    expect(s).toContain("Lisboa");
    expect(s).not.toMatch(/@|\+\d/);
  });

  it.each([["Fatal, nadie vino", true], ["Muy mal servicio", true], ["Todo perfecto, gracias", false], ["Buenas tardes, todo bien", false]])(
    "isNegativeFeedback(%s) = %s", (t, v) => expect(isNegativeFeedback(t)).toBe(v));
});
