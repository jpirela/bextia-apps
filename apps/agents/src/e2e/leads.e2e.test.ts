import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { lead, sales_agent } from "../db/schema.ts";
import { createSimulatorChannel } from "../channels/json-channel.ts";
import { createScriptedLlm } from "../llm/scripted.ts";
import { createStaticKb } from "../rag/kb.ts";
import { createRateLimiter } from "../server/rate-limit.ts";
import { createPipeline } from "../server/pipeline.ts";
import { createApp } from "../server/app.ts";
import { createLeadsAgent } from "../leads/agent.ts";
import { deliverDue } from "../leads/delivery.ts";
import type { Mail } from "../notify/mailer.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const nulls = { destino: null, fecha_inicio: null, fecha_fin: null, viajeros: null, interes: null, urgencia: null, tipo: null, idioma: "es", nombre: null, email: null, telefono: null, pregunta: null };

describe("E2E: lead fuera de horario completo", () => {
  it("conversa, cualifica, asigna y entrega al inicio de la jornada", async () => {
    await db.insert(sales_agent).values({ nombre: "Beto", email: "beto@bextia.test", destinos: ["japon"], zona_horaria: "Europe/Madrid" });
    const sim = createSimulatorChannel();
    const llm = createScriptedLlm({
      classify: [
        { ok: true, value: { ...nulls, destino: "Japón", nombre: "Luz" } },
        { ok: true, value: { ...nulls, destino: "Japón", fecha_inicio: "2026-12-01", fecha_fin: "2026-12-12", viajeros: 2, interes: "cultura", urgencia: "media", tipo: "vacacional" } },
        { ok: true, value: { resumen: "Luz y su pareja quieren Japón (cultura) del 1 al 12 de diciembre." } },
      ],
      converse: [
        { ok: true, value: "¡Hola Luz! ¿Qué fechas y cuántas personas viajan?" },
        { ok: true, value: "Perfecto. Un comercial te escribirá mañana a primera hora." },
      ],
    });
    const agent = createLeadsAgent({ db, llm, kb: createStaticKb([]), send: sim.adapter.send, notifyNow: async () => {},
      now: () => new Date("2026-11-09T22:00:00Z") }); // reloj fijo: la noche anterior a la entrega
    const app = createApp({
      apiToken: "tok", corsOrigins: [], routes: {}, channels: { sim: sim.adapter },
      pipeline: createPipeline({ db, defaultMarket: "ES", contactLimiter: createRateLimiter({ limit: 50, windowMs: 60_000 }), dispatch: agent }),
      ipLimiter: createRateLimiter({ limit: 50, windowMs: 60_000 }), simulator: { outbox: sim.outbox },
    });
    const post = (text: string, messageId: string) => app.request("/webhooks/sim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId, email: "luz@example.com", name: "Luz", text }),
    });

    expect((await post("Hola, quiero ir a Japón", "e2e-1")).status).toBe(200);
    expect((await post("Del 1 al 12 de diciembre, somos 2, nos interesa la cultura", "e2e-2")).status).toBe(200);

    const outbox = await (await app.request("/sim/outbox")).json() as Array<{ text: string }>;
    expect(outbox.map((m) => m.text)).toEqual([
      "¡Hola Luz! ¿Qué fechas y cuántas personas viajan?",
      "Perfecto. Un comercial te escribirá mañana a primera hora.",
    ]);
    expect((await db.select().from(lead))[0].estado).toBe("asignado");

    const sent: Mail[] = [];
    const mailer = { async send(m: Mail) { sent.push(m); return { messageId: "x" }; } };
    const r = await deliverDue({ db, mailer, now: () => new Date("2026-11-10T07:05:00Z") });
    expect(r).toEqual({ delivered: 1, failed: 0 });
    expect(sent[0].to).toBe("beto@bextia.test");
    expect(sent[0].text).toContain("Japón (cultura)");
    expect((await db.select().from(lead))[0].estado).toBe("entregado");
  });
});
