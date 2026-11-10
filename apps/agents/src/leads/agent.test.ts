import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { business_hours, kpi_event, lead, message, sales_agent } from "../db/schema.ts";
import type { InboundMessage, OutboundMessage } from "../channels/types.ts";
import { createScriptedLlm } from "../llm/scripted.ts";
import { FALLBACK_REPLY, type LlmResult } from "../llm/types.ts";
import { createStaticKb, type KnowledgeBase } from "../rag/kb.ts";
import { createRateLimiter } from "../server/rate-limit.ts";
import { createPipeline } from "../server/pipeline.ts";
import type { Qualification } from "./qualify.ts";
import { createLeadsAgent } from "./agent.ts";
import { toMessageParams, UNSUPPORTED_REPLY } from "./prompts.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const none: Qualification = {
  destino: null, fecha_inicio: null, fecha_fin: null, viajeros: null, interes: null, urgencia: null, tipo: null,
  idioma: "es", nombre: null, email: null, telefono: null, pregunta: null,
};
const q = (over: Partial<Qualification>): LlmResult<unknown> => ({ ok: true, value: { ...none, ...over } });
const fail: LlmResult<never> = { ok: false, reason: "api_error", detail: "500 InternalServerError" };
const at = new Date("2026-11-09T22:00:00Z"); // lunes 23:00 Madrid
const inbound = (externalId: string, text: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "sim", externalId, from: { email: "luz@example.com", name: "Luz" }, text, receivedAt: at, ...over,
});

function setup(script: Parameters<typeof createScriptedLlm>[0], kb: KnowledgeBase = createStaticKb([])) {
  const llm = createScriptedLlm(script);
  const sent: OutboundMessage[] = [];
  const notifyNow = vi.fn(async () => {});
  const agent = createLeadsAgent({
    db, llm, kb, notifyNow, now: () => new Date("2026-11-09T22:00:05Z"),
    send: async (m) => { sent.push(m); return { externalId: `sent-${sent.length}` }; },
  });
  const run = createPipeline({ db, defaultMarket: "ES", contactLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), dispatch: agent });
  return { llm, sent, notifyNow, run };
}

describe("Agente 1 fuera de horario", () => {
  it("responde al primer mensaje y deja el lead en respondido", async () => {
    const { sent, run, llm } = setup({ classify: [q({ destino: "Japón" })], converse: [{ ok: true, value: "¡Japón! ¿Qué fechas y cuántos viajan?" }] });
    await run(inbound("m1", "Hola, quiero ir a Japón"));
    expect(sent).toEqual([{ channel: "sim", to: { email: "luz@example.com" }, text: "¡Japón! ¿Qué fechas y cuántos viajan?" }]);
    const [l] = await db.select().from(lead);
    expect(l).toMatchObject({ estado: "respondido", destino: "Japón", fuera_de_horario: true, requiere_humano: false });
    expect(l.score).toBeGreaterThan(0);
    const out = await db.select().from(message).where(eq(message.direccion, "out"));
    expect(out).toMatchObject([{ contenido: "¡Japón! ¿Qué fechas y cuántos viajan?", external_id: "sent-1", agente: "leads" }]);
    const [k] = await db.select().from(kpi_event).where(eq(kpi_event.tipo, "respuesta_enviada"));
    expect(k.valor).toBe(5000);
    expect(llm.calls.converse[0].messages).toEqual([{ role: "user", content: "Hola, quiero ir a Japón" }]);
  });

  it("con todos los datos cualifica, resume y asigna (sin entregar)", async () => {
    await db.insert(sales_agent).values({ nombre: "Beto", email: "beto@bextia.test", destinos: ["japon"] });
    const { run, notifyNow } = setup({
      classify: [
        q({ destino: "Japón" }),
        q({ destino: "Japón", fecha_inicio: "2026-12-01", fecha_fin: "2026-12-12", viajeros: 2, interes: "cultura", urgencia: "media" }),
        { ok: true, value: { resumen: "Pareja a Japón en diciembre." } },
      ],
      converse: [{ ok: true, value: "¿Fechas?" }, { ok: true, value: "¡Perfecto! Un comercial te escribirá mañana." }],
    });
    await run(inbound("m1", "Japón"));
    await run(inbound("m2", "Del 1 al 12 de diciembre, 2 personas, cultura, sin prisa"));
    const [l] = await db.select().from(lead);
    expect(l).toMatchObject({ estado: "asignado", resumen_ia: "Pareja a Japón en diciembre.", viajeros: 2 });
    expect(l.sales_agent_id).not.toBeNull();
    expect(notifyNow).not.toHaveBeenCalled();
  });

  it("dos mensajes seguidos en segundo plano: una sola respuesta, sin respaldo", async () => {
    const llm = createScriptedLlm({ classify: [q({ destino: "Japón" })], converse: [{ ok: true, value: "¡Japón! ¿Fechas?" }] });
    const sent: OutboundMessage[] = [];
    const agent = createLeadsAgent({
      db, llm, kb: createStaticKb([]), notifyNow: async () => {}, now: () => new Date("2026-11-09T22:00:05Z"),
      send: async (m) => { sent.push(m); return { externalId: `sent-${sent.length}` }; },
    });
    let done!: () => void;
    const idle = new Promise<void>((r) => { done = r; });
    let calls = 0;
    const dispatch: typeof agent = async (ctx) => { try { await agent(ctx); } finally { if (++calls === 2) done(); } };
    const run = createPipeline({ db, defaultMarket: "ES", contactLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), dispatch, background: true });
    await run(inbound("m1", "Hola"));
    await run(inbound("m2", "quiero ir a Japón"));
    await idle;
    expect(sent.map((m) => m.text)).toEqual(["¡Japón! ¿Fechas?"]);
    const [l] = await db.select().from(lead);
    expect(l).toMatchObject({ estado: "respondido", requiere_humano: false });
  });

  it("fallo del LLM: respuesta de respaldo y caso para humano", async () => {
    const { sent, run } = setup({ classify: [fail], converse: [fail] });
    await run(inbound("m1", "Hola"));
    expect(sent[0].text).toBe(FALLBACK_REPLY);
    const [l] = await db.select().from(lead);
    expect(l.requiere_humano).toBe(true);
    expect(await db.select().from(kpi_event).where(eq(kpi_event.tipo, "fallback_llm"))).toHaveLength(1);
  });

  it("FAQ: busca en la KB y pasa el artículo al prompt", async () => {
    const kb = createStaticKb([{ id: "a1", titulo: "Equipaje", contenido: "Una maleta de 23 kg incluida.", similarity: 0.9 }]);
    const search = vi.spyOn(kb, "search");
    const { run, llm } = setup({ classify: [q({ pregunta: "¿cuánto equipaje puedo llevar?" })], converse: [{ ok: true, value: "23 kg." }] }, kb);
    await run(inbound("m1", "¿Cuánto equipaje puedo llevar?"));
    expect(search).toHaveBeenCalledWith("¿cuánto equipaje puedo llevar?", { k: 3, idioma: "es" });
    expect(llm.calls.converse[0].system).toContain("Una maleta de 23 kg incluida.");
  });

  it("mensaje no textual: respuesta fija sin LLM", async () => {
    const { sent, run, llm } = setup({});
    await run(inbound("m1", "[image]", { unsupported: true }));
    expect(sent[0].text).toBe(UNSUPPORTED_REPLY);
    expect(llm.calls.classify).toHaveLength(0);
  });

  it("fallo de envío: kpi envio_fallido y caso para humano, sin mensaje out", async () => {
    const llm = createScriptedLlm({ classify: [q({})], converse: [{ ok: true, value: "Hola" }] });
    const agent = createLeadsAgent({ db, llm, kb: createStaticKb([]), notifyNow: async () => {}, send: async () => { throw new Error("smtp"); } });
    const run = createPipeline({ db, defaultMarket: "ES", contactLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), dispatch: agent });
    await run(inbound("m1", "Hola"));
    expect(await db.select().from(message).where(eq(message.direccion, "out"))).toHaveLength(0);
    expect((await db.select().from(lead))[0].requiere_humano).toBe(true);
    expect(await db.select().from(kpi_event).where(eq(kpi_event.tipo, "envio_fallido"))).toHaveLength(1);
  });
});

describe("Agente 1 dentro de horario", () => {
  beforeEach(async () => {
    const all: [string, string][] = [["00:00", "23:59"]];
    await db.insert(business_hours).values({ mercado: "ES", zona_horaria: "Europe/Madrid", horario: { mon: all, tue: all, wed: all, thu: all, fri: all, sat: all, sun: all } });
    await db.insert(sales_agent).values({ nombre: "Beto", email: "beto@bextia.test" });
  });

  it("registra, asigna y notifica una sola vez, sin responder", async () => {
    const { sent, run, notifyNow, llm } = setup({
      classify: [q({ destino: "Perú" }), { ok: true, value: { resumen: "Quiere ir a Perú." } }, q({ destino: "Perú", viajeros: 3 })],
    });
    await run(inbound("m1", "Info de Perú"));
    await run(inbound("m2", "Somos 3"));
    expect(sent).toHaveLength(0);
    expect(llm.calls.converse).toHaveLength(0);
    expect(notifyNow).toHaveBeenCalledTimes(1);
    const [l] = await db.select().from(lead);
    expect(l).toMatchObject({ estado: "asignado", fuera_de_horario: false, viajeros: 3 });
  });
});

describe("toMessageParams", () => {
  it("une turnos consecutivos y empieza en user", () => {
    expect(toMessageParams([
      { direccion: "out", contenido: "Bienvenida" },
      { direccion: "in", contenido: "a" }, { direccion: "in", contenido: "b" },
      { direccion: "out", contenido: "c" },
    ])).toEqual([{ role: "user", content: "a\nb" }, { role: "assistant", content: "c" }]);
  });
  it("ignora agentes que no son leads", async () => {
    const llm = createScriptedLlm({});
    const send = vi.fn();
    const agent = createLeadsAgent({ db, llm, kb: createStaticKb([]), notifyNow: async () => {}, send });
    await agent({
      msg: inbound("z", "x"),
      ingest: { duplicate: false, contact: {} as never, conversationId: "00000000-0000-0000-0000-000000000000", messageId: null },
      decision: { agent: "incidents", market: "ES", withinHours: false, bookingId: "b" },
    });
    expect(send).not.toHaveBeenCalled();
    expect(llm.calls.classify).toHaveLength(0);
  });
});
