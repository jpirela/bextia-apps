import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, incident, on_call } from "../db/schema.ts";
import { createSimulatorChannel } from "../channels/json-channel.ts";
import { createWebChannel } from "../channels/web.ts";
import { createScriptedLlm } from "../llm/scripted.ts";
import type { LlmResult } from "../llm/types.ts";
import { createStaticKb } from "../rag/kb.ts";
import { createRateLimiter } from "../server/rate-limit.ts";
import { createPipeline } from "../server/pipeline.ts";
import { createApp } from "../server/app.ts";
import { seedProtocol } from "../protocols/seed.ts";
import { createIncidentsAgent } from "../incidents/agent.ts";
import { runDueTimers } from "../incidents/sla.ts";
import type { Mail } from "../notify/mailer.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const SECRET = "s".repeat(32);
let now: Date;

const traslado = (over = {}): LlmResult<unknown> => ({
  ok: true,
  value: { tipologia: "traslado_no_presentado", urgencia: "alta", emocional: false, impacto_economico_alto: false, idioma: "es", resumen: "No llegó el traslado.", ...over },
});

async function setup(script: Parameters<typeof createScriptedLlm>[0]) {
  now = new Date();
  await db.insert(booking).values({
    codigo: "BX-1001", viajero_nombre: "Ana García", destino: "Lisboa", viajero_email: "ana@example.com",
    inicio: new Date(now.getTime() - 86_400_000), fin: new Date(now.getTime() + 5 * 86_400_000),
    servicios: [{ tipo: "traslado", proveedor: "TransLis", email: "ops@translis.test", lugar: "Aeropuerto LIS", referencia: "TL-77", inicio: now.toISOString() }],
  });
  await db.insert(on_call).values({ nombre: "Guardia", email: "guardia@bextia.test" });
  await seedProtocol(db, { tope: 40, moneda: "EUR" });

  const sim = createSimulatorChannel();
  const mails: Mail[] = [];
  const mailer = { async send(m: Mail) { mails.push(m); return { messageId: "x" }; } };
  const providerChannels = { whatsapp: false, email: false, sim: true };
  const web = createWebChannel({ tokenSecret: SECRET, send: async () => ({ externalId: "" }) });
  const channels = { sim: sim.adapter, web };
  const send = (m: Parameters<typeof sim.adapter.send>[0]) => channels[m.channel as "sim" | "web"].send(m);
  const agent = createIncidentsAgent({
    db, llm: createScriptedLlm(script), mailer, providerChannels, now: () => now, send,
    kb: createStaticKb([{ id: "k1", titulo: "Wifi del hotel", contenido: "La clave está en recepción.", similarity: 0.9 }]),
  });
  const otps: string[] = [];
  const app = createApp({
    apiToken: "tok", corsOrigins: [], routes: {}, channels,
    pipeline: createPipeline({ db, defaultMarket: "ES", contactLimiter: createRateLimiter({ limit: 50, windowMs: 60_000 }), dispatch: agent }),
    ipLimiter: createRateLimiter({ limit: 200, windowMs: 60_000 }), simulator: { outbox: sim.outbox },
    widget: { db, tokenSecret: SECRET, deliverOtp: async (_d, codigo) => { otps.push(codigo); } },
  });
  let n = 0;
  const post = (email: string, text: string) => app.request("/webhooks/sim", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageId: `e2e-${++n}`, email, name: "x", text }),
  });
  const outboxTo = async (email: string) =>
    ((await (await app.request("/sim/outbox")).json()) as Array<{ text: string; to: { email?: string } }>)
      .filter((m) => m.to.email === email).map((m) => m.text);
  const runner = { db, send, now: () => now, mailer, providerChannels };
  return { app, post, outboxTo, runner, mails, otps };
}

describe("E2E: traslado no presentado", () => {
  it("el proveedor confirma la ETA a tiempo", async () => {
    const { post, outboxTo } = await setup({ classify: [traslado()] });
    expect((await post("ana@example.com", "El traslado no ha llegado al aeropuerto")).status).toBe(200);
    expect((await outboxTo("ops@translis.test"))[0]).toContain("TL-77");
    expect((await post("ops@translis.test", "Llegamos en 20 min")).status).toBe(200);
    const ana = await outboxTo("ana@example.com");
    expect(ana).toContain("Buenas noticias: TransLis llega en unos 20 minutos a Aeropuerto LIS.");
    expect(ana.at(-1)).toBe("Cuando estés en el hotel, cuéntanos en una frase cómo fue todo.");
    expect((await db.select().from(incident))[0].estado).toBe("seguimiento");
  });

  it("el proveedor no responde: a los 16 min se autoriza el taxi por el tope", async () => {
    const { post, outboxTo, runner } = await setup({ classify: [traslado()] });
    await post("ana@example.com", "El traslado no ha llegado");
    now = new Date(now.getTime() + 16 * 60_000);
    expect(await runDueTimers(runner)).toEqual({ ran: 1, failed: 0 });
    const ana = await outboxTo("ana@example.com");
    expect(ana).toContain("TransLis no confirmó a tiempo. Toma un taxi oficial hasta tu hotel: te reembolsamos hasta 40.00 EUR. Guarda el recibo.");
  });
});

describe("E2E: escalado y consultas", () => {
  it("emergencia: 112 al viajero y email a la guardia", async () => {
    const { post, outboxTo, mails } = await setup({});
    await post("ana@example.com", "Hemos tenido un accidente con el coche");
    expect((await outboxTo("ana@example.com"))[0]).toContain("112");
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("guardia@bextia.test");
    expect(mails[0].text).toContain("BX-1001");
    expect(mails[0].text).not.toContain("ana@example.com");
  });

  it("consulta respondida con la base de conocimiento", async () => {
    const { post, outboxTo } = await setup({
      classify: [traslado({ tipologia: "consulta", urgencia: "baja" })],
      converse: [{ ok: true, value: "La clave del wifi te la dan en recepción." }],
    });
    await post("ana@example.com", "¿Cuál es la clave del wifi?");
    expect((await outboxTo("ana@example.com")).at(-1)).toBe("La clave del wifi te la dan en recepción.");
  });
});

describe("E2E: widget web", () => {
  it("OTP → token → mensaje → respuesta visible en el widget", async () => {
    const { app, otps } = await setup({
      classify: [traslado({ tipologia: "consulta", urgencia: "baja" })],
      converse: [{ ok: true, value: "Te ayudamos." }],
    });
    const json = { "content-type": "application/json" };
    expect((await app.request("/widget/otp", { method: "POST", headers: json, body: JSON.stringify({ destino: "ana@example.com" }) })).status).toBe(202);
    const tok = await app.request("/widget/token", {
      method: "POST", headers: json, body: JSON.stringify({ destino: "ana@example.com", codigo: otps[0] }),
    });
    expect(tok.status).toBe(200);
    const { token } = await tok.json() as { token: string };
    const auth = { ...json, authorization: `Bearer ${token}` };
    expect((await app.request("/webhooks/web", { method: "POST", headers: auth, body: JSON.stringify({ messageId: "w-1", text: "¿Hay desayuno?" }) })).status).toBe(200);
    const msgs = await (await app.request("/widget/messages", { headers: auth })).json() as Array<{ direccion: string; contenido: string }>;
    expect(msgs.map((m) => m.contenido)).toContain("Te ayudamos.");
    expect((await app.request("/webhooks/web", { method: "POST", headers: json, body: JSON.stringify({ messageId: "w-2", text: "x" }) })).status).toBe(401);
  });
});
