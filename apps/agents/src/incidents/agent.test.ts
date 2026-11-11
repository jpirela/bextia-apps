import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, incident, incident_action, on_call } from "../db/schema.ts";
import type { InboundMessage, OutboundMessage } from "../channels/types.ts";
import { ingest } from "../gateway/ingest.ts";
import { createScriptedLlm } from "../llm/scripted.ts";
import type { LlmResult } from "../llm/types.ts";
import { createStaticKb } from "../rag/kb.ts";
import { createRateLimiter } from "../server/rate-limit.ts";
import { createPipeline } from "../server/pipeline.ts";
import { seedProtocol } from "../protocols/seed.ts";
import { createIncidentsAgent, redactForLlm, surnameMatches } from "./agent.ts";
import type { IncidentClass } from "./classify.ts";
import {
  ASK_NAME, EMERGENCY_REPLY, ESCALATED_REPLY, ESCALATED_WAIT, FEEDBACK_THANKS, NAME_MISMATCH, PROTOCOL_IN_PROGRESS, welcomeMessage,
} from "./prompts.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => { vi.restoreAllMocks(); await close(); });

let now = new Date("2026-11-08T10:05:00Z");
let sent: OutboundMessage[];
let n = 0;

const cls = (over: Partial<IncidentClass> = {}): LlmResult<unknown> => ({
  ok: true,
  value: { tipologia: "traslado_no_presentado", urgencia: "alta", emocional: false, impacto_economico_alto: false, idioma: "es", resumen: "No llegó el traslado.", ...over },
});

// BD que falla al registrar la acción "decision" (primer efecto del runner tras el commit de startProtocol).
function failingDecisionLog(real: Db): Db {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "insert") {
        return (table: unknown) => {
          const builder = (target.insert as (t: unknown) => { values: (v: unknown) => unknown })(table);
          if (table !== incident_action) return builder;
          return new Proxy(builder, {
            get(b, p) {
              if (p === "values") {
                return (v: { tipo?: string }) => {
                  if (v.tipo === "decision") throw new TypeError("fallo simulado");
                  return b.values(v);
                };
              }
              const val = Reflect.get(b, p, b);
              return typeof val === "function" ? val.bind(b) : val;
            },
          });
        };
      }
      const val = Reflect.get(target, prop, target);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

async function setup(script: Parameters<typeof createScriptedLlm>[0] = {}, opts: { agentDb?: (db: Db) => Db } = {}) {
  now = new Date("2026-11-08T10:05:00Z");
  sent = [];
  await db.insert(booking).values({
    codigo: "BX-1001", viajero_nombre: "Ana García López", destino: "Lisboa", viajero_email: "ana@example.com",
    inicio: new Date("2026-11-07T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
    servicios: [{ tipo: "traslado", proveedor: "TransLis", email: "ops@translis.test", inicio: "2026-11-08T10:00:00Z", lugar: "Aeropuerto LIS", referencia: "TL-77" }],
  });
  await db.insert(on_call).values({ nombre: "Guardia", email: "guardia@bextia.test" });
  await seedProtocol(db, { tope: 40, moneda: "EUR" });
  const llm = createScriptedLlm(script);
  const agent = createIncidentsAgent({
    db: opts.agentDb ? opts.agentDb(db) : db, llm, mailer: null, now: () => now, providerChannels: { whatsapp: false, email: false, sim: true },
    kb: createStaticKb([{ id: "k1", titulo: "Check-in del hotel", contenido: "Desde las 15:00.", similarity: 0.9 }]),
    send: async (m) => { sent.push(m); return { externalId: "" }; },
  });
  const run = createPipeline({ db, defaultMarket: "ES", contactLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), dispatch: agent });
  const inbound = (email: string, text: string): InboundMessage => ({ channel: "sim", externalId: `m-${++n}`, from: { email }, text, receivedAt: now });
  const say = (email: string, text: string) => run(inbound(email, text));
  return { llm, say, agent, inbound };
}

const to = (email: string) => sent.filter((m) => m.to.email === email).map((m) => m.text);
const inc = async () => (await db.select().from(incident))[0];

describe("surnameMatches", () => {
  it.each([
    ["Ana García López", "Soy Ana, apellido garcia", true],
    ["Ana García López", "LÓPEZ", true],
    ["Ana García López", "Ana", false],
    ["Ana García López", "Garcíaz", false],
    ["Ana Li", "li", false],
  ])("%s / %s → %s", (full, text, v) => expect(surnameMatches(full, text)).toBe(v));
});

describe("redactForLlm", () => {
  const b = { codigo: "BX-1001", servicios: [{ tipo: "traslado", proveedor: "TransLis", referencia: "TL-77" }] };
  it("quita email, teléfono, código de reserva y proveedor; deja horas y minutos", () => {
    const out = redactForLlm("Soy ana@example.com, tel +34 600 111 222, reserva bx-1001 y CD-99999; TransLis (TL-77) a las 15:00, 20 min", b);
    for (const s of ["ana@example.com", "600 111 222", "bx-1001", "CD-99999", "TransLis", "TL-77"]) expect(out).not.toContain(s);
    expect(out).toContain("15:00");
    expect(out).toContain("20 min");
  });
});

describe("Agente 2", () => {
  it("viajero identificado por contacto: bienvenida, clasifica y arranca el protocolo", async () => {
    const { say } = await setup({ classify: [cls()] });
    await say("ana@example.com", "El traslado no ha llegado al aeropuerto");
    expect(to("ana@example.com")).toEqual([
      welcomeMessage({ viajero_nombre: "Ana García López", destino: "Lisboa" }),
      "Ana, ya estamos contactando a TransLis. Te escribimos en un máximo de 15 minutos.",
    ]);
    expect(to("ops@translis.test")[0]).toContain("TL-77");
    expect(await inc()).toMatchObject({ estado: "protocolo", tipologia: "traslado_no_presentado", urgencia: "alta", proveedor_contacto: "ops@translis.test" });
    expect((await db.select().from(booking))[0].bienvenida_at).not.toBeNull();
  });

  it("respuesta del proveedor con ETA → avisa al viajero; feedback positivo cierra", async () => {
    const { say, llm } = await setup({ classify: [cls()] });
    await say("ana@example.com", "El traslado no ha llegado");
    await say("ops@translis.test", "Llegamos en 20 min");
    expect(to("ana@example.com").slice(2)).toEqual([
      "Buenas noticias: TransLis llega en unos 20 minutos a Aeropuerto LIS.",
      "Cuando estés en el hotel, cuéntanos en una frase cómo fue todo.",
    ]);
    expect((await inc()).estado).toBe("seguimiento");
    await say("ana@example.com", "Todo perfecto, gracias");
    expect(to("ana@example.com").at(-1)).toBe(FEEDBACK_THANKS);
    expect(await inc()).toMatchObject({ estado: "cerrado", feedback: "Todo perfecto, gracias" });
    expect(llm.calls.classify).toHaveLength(1); // la ETA se leyó por regex
  });

  it("respuesta duplicada del proveedor → solo una gana la espera (claimWait), sin efectos dobles", async () => {
    const { say, agent, inbound } = await setup({ classify: [cls()] });
    await say("ana@example.com", "El traslado no ha llegado");
    const { id } = await inc();
    const dispatchProvider = async (text: string) => {
      const msg = inbound("ops@translis.test", text);
      const ing = await ingest(db, msg);
      await agent({
        msg, ingest: ing,
        decision: { agent: "incidents", market: "ES", withinHours: false, bookingId: (await inc()).booking_id, verified: false, providerIncidentId: id },
      });
    };
    await Promise.all([dispatchProvider("20 min"), dispatchProvider("Llegamos en 20 min")]);
    expect(to("ana@example.com").filter((t) => t.startsWith("Buenas noticias"))).toHaveLength(1);
    expect((await inc()).estado).toBe("seguimiento");
    const before = sent.length;
    await dispatchProvider("20 min"); // tardía: la espera ya se reclamó
    expect(sent).toHaveLength(before);
  });

  it("mensaje del viajero durante la espera → protocolo en curso, sin LLM", async () => {
    const { say, llm } = await setup({ classify: [cls()] });
    await say("ana@example.com", "El traslado no ha llegado");
    await say("ana@example.com", "¿Alguna novedad?");
    expect(to("ana@example.com").at(-1)).toBe(PROTOCOL_IN_PROGRESS);
    expect(llm.calls.classify).toHaveLength(1);
  });

  it("feedback negativo → escala", async () => {
    const { say } = await setup({ classify: [cls()] });
    await say("ana@example.com", "El traslado no ha llegado");
    await say("ops@translis.test", "20 min");
    await say("ana@example.com", "Fatal, nadie nos esperaba");
    expect(await inc()).toMatchObject({ estado: "escalado", requiere_humano: true });
    expect(to("ana@example.com").at(-1)).toBe(ESCALATED_REPLY);
  });

  it("contacto desconocido con código de reserva: pide apellido y lo verifica", async () => {
    const { say, llm } = await setup();
    await say("otro@example.com", "Hola, reserva BX-1001");
    expect(to("otro@example.com")).toEqual([ASK_NAME]);
    await say("otro@example.com", "Pérez");
    expect(to("otro@example.com").at(-1)).toBe(NAME_MISMATCH);
    await say("otro@example.com", "García");
    expect(to("otro@example.com").at(-1)).toBe(welcomeMessage({ viajero_nombre: "Ana García López", destino: "Lisboa" }));
    expect(await inc()).toMatchObject({ estado: "bienvenida", intentos_identificacion: 2 });
    expect((await db.select().from(booking))[0].contact_id).not.toBeNull();
    expect((await db.select().from(incident_action)).map((a) => a.tipo)).toContain("identificacion");
    expect(llm.calls.classify).toHaveLength(0);
  });

  it("tres apellidos erróneos → escala", async () => {
    const { say } = await setup();
    await say("otro@example.com", "Reserva BX-1001");
    await say("otro@example.com", "Pérez");
    await say("otro@example.com", "Ruiz");
    expect(to("otro@example.com").at(-1)).toBe(ESCALATED_REPLY);
    expect(await inc()).toMatchObject({ estado: "escalado" });
    const esc = (await db.select().from(incident_action)).find((a) => a.tipo === "escalado");
    expect(esc?.detalle).toMatchObject({ motivo: "identificacion_fallida" });
  });

  it("emergencia → 112 y escalado inmediato, sin LLM", async () => {
    const { say, llm } = await setup();
    await say("ana@example.com", "Mi hijo está sangrando mucho");
    expect(to("ana@example.com")).toEqual([EMERGENCY_REPLY]);
    expect(await inc()).toMatchObject({ estado: "escalado", tipologia: "emergencia", urgencia: "critica", requiere_humano: true });
    expect(llm.calls.classify).toHaveLength(0);
    await say("ana@example.com", "¿Siguen ahí?");
    expect(to("ana@example.com").at(-1)).toBe(ESCALATED_WAIT);
  });

  it("emergencia de un remitente sin identificar → escala igual, sin LLM", async () => {
    const { say, llm } = await setup();
    await say("otro@example.com", "Reserva BX-1001, nos han robado y hay un herido");
    expect(to("otro@example.com")).toEqual([EMERGENCY_REPLY]);
    expect(await inc()).toMatchObject({ estado: "escalado", tipologia: "emergencia" });
    expect(llm.calls.classify).toHaveLength(0);
  });

  it("consulta → RAG con Sonnet, sin PII en el system prompt", async () => {
    const { say, llm } = await setup({
      classify: [cls({ tipologia: "consulta", urgencia: "baja" })],
      converse: [{ ok: true, value: "El check-in es desde las 15:00." }],
    });
    await say("ana@example.com", "¿A qué hora es el check-in?");
    expect(to("ana@example.com").at(-1)).toBe("El check-in es desde las 15:00.");
    expect((await inc()).estado).toBe("conversacional");
    const system = llm.calls.converse[0].system;
    expect(system).toContain("Check-in del hotel");
    expect(system).not.toContain("ana@example.com");
    expect(system).not.toContain("BX-1001");
  });

  it("el texto del viajero llega al LLM sin email, teléfono ni código de reserva", async () => {
    const { say, llm } = await setup({
      classify: [cls({ tipologia: "consulta", urgencia: "baja" })],
      converse: [{ ok: true, value: "Desde las 15:00." }],
    });
    await say("ana@example.com", "Reserva BX-1001, mi móvil +34 600 111 222 y ana@example.com: ¿a qué hora es el check-in?");
    const prompts = JSON.stringify([llm.calls.classify, llm.calls.converse]);
    for (const s of ["BX-1001", "600 111 222", "ana@example.com", "TransLis"]) expect(prompts).not.toContain(s);
    expect(prompts).toContain("check-in");
  });

  it("fallo del LLM en una consulta → escalado con requiere_humano", async () => {
    const { say } = await setup({
      classify: [cls({ tipologia: "consulta", urgencia: "baja" })],
      converse: [{ ok: false, reason: "api_error", detail: "x" }],
    });
    await say("ana@example.com", "¿Hay wifi en el hotel?");
    expect(to("ana@example.com").at(-1)).toBe(ESCALATED_REPLY);
    expect(await inc()).toMatchObject({ estado: "escalado", requiere_humano: true });
  });

  it("clasificación fallida → escalado", async () => {
    const { say } = await setup({ classify: [{ ok: false, reason: "invalid_output", detail: "x" }] });
    await say("ana@example.com", "Tengo un problema");
    expect(await inc()).toMatchObject({ estado: "escalado" });
  });

  it("runProtocol lanza tras el commit de startProtocol → aviso, escalado y protocolo terminado (M3)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { say } = await setup({ classify: [cls()] }, { agentDb: failingDecisionLog });
    await say("ana@example.com", "El traslado no ha llegado");
    const row = await inc();
    expect(row).toMatchObject({ estado: "escalado", requiere_humano: true, proximo_paso_at: null });
    expect(row.protocolo_estado?.terminado).toBe(true);
    expect(to("ana@example.com").at(-1)).toBe(ESCALATED_REPLY);
    expect(to("ops@translis.test")).toHaveLength(0); // el fallo fue antes de contactar al proveedor
    const esc = (await db.select().from(incident_action)).find((a) => a.tipo === "escalado");
    expect(esc?.detalle).toMatchObject({ motivo: "error_interno" });
    // Logs sin PII: solo err.name.
    for (const call of errors.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/ana@example\.com|BX-1001|fallo simulado/);
    }
  });

  it("un error inesperado nunca se propaga al canal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { say } = await setup(); // guion vacío: classify lanza
    await expect(say("ana@example.com", "Tengo un problema")).resolves.toMatchObject({ status: "routed" });
    expect(await inc()).toMatchObject({ estado: "escalado", requiere_humano: true });
    expect(to("ana@example.com").at(-1)).toBe(ESCALATED_REPLY);
  });

  it("decisión de leads → no hace nada", async () => {
    const { say } = await setup();
    await say("nuevo@example.com", "Quiero ir a Japón");
    expect(sent).toHaveLength(0);
    expect(await db.select().from(incident)).toHaveLength(0);
  });
});
