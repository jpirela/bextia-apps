import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, incident, incident_action, kpi_event, on_call } from "../db/schema.ts";
import type { Channel, InboundMessage, OutboundMessage } from "../channels/types.ts";
import { message } from "../db/schema.ts";
import type { KbHit } from "../rag/kb.ts";
import { ingest } from "../gateway/ingest.ts";
import { createScriptedLlm } from "../llm/scripted.ts";
import type { LlmResult } from "../llm/types.ts";
import type { Mailer } from "../notify/mailer.ts";
import { createStaticKb } from "../rag/kb.ts";
import { createRateLimiter } from "../server/rate-limit.ts";
import { createPipeline } from "../server/pipeline.ts";
import { seedProtocol } from "../protocols/seed.ts";
import { createIncidentsAgent, redactForLlm, surnameMatches } from "./agent.ts";
import type { IncidentClass } from "./classify.ts";
import {
  ASK_NAME, EMERGENCY_REPLY, ESCALATED_REPLY, ESCALATED_WAIT, FEEDBACK_THANKS, NAME_MISMATCH, PROTOCOL_IN_PROGRESS,
  TEMPORARY_ERROR_REPLY, welcomeMessage,
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

// BD que falla al insertar en `table` las filas que cumplan `when`.
const failingInsert = (table: unknown, when: (v: Record<string, unknown>) => boolean) => (real: Db): Db => {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "insert") {
        return (t: unknown) => {
          const builder = (target.insert as (t: unknown) => { values: (v: unknown) => unknown })(t);
          if (t !== table) return builder;
          return new Proxy(builder, {
            get(b, p) {
              if (p === "values") {
                return (v: Record<string, unknown>) => {
                  if (when(v)) throw new TypeError("fallo simulado");
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
};
// Falla el logAction("decision"): primer efecto del runner tras el commit de startProtocol.
const failingDecisionLog = failingInsert(incident_action, (v) => v.tipo === "decision");
// Falla la creación de la incidencia: error antes de que exista.
const failingIncidentCreate = failingInsert(incident, () => true);

async function setup(
  script: Parameters<typeof createScriptedLlm>[0] = {},
  opts: { agentDb?: (db: Db) => Db; mailer?: Mailer; kb?: KbHit[] } = {},
) {
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
    db: opts.agentDb ? opts.agentDb(db) : db, llm, mailer: opts.mailer ?? null, now: () => now, providerChannels: { whatsapp: false, email: false, sim: true },
    kb: createStaticKb(opts.kb ?? [{ id: "k1", titulo: "Check-in del hotel", contenido: "Desde las 15:00.", similarity: 0.9 }]),
    send: async (m) => { sent.push(m); return { externalId: "" }; },
  });
  const run = createPipeline({ db, defaultMarket: "ES", contactLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), dispatch: agent });
  const inbound = (email: string, text: string, channel: Channel = "sim"): InboundMessage =>
    ({ channel, externalId: `m-${++n}`, from: { email }, text, receivedAt: now });
  const say = (email: string, text: string, channel: Channel = "sim") => run(inbound(email, text, channel));
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

  // Sondas de la revisión: proveedor "Sol", referencia "12".
  const sol = { codigo: "BX-1001", viajero_nombre: "Ana García López", servicios: [{ tipo: "traslado", proveedor: "Sol", referencia: "12" }] };
  it.each([
    ["Soledad", "Soledad"], // "Sol" solo como palabra completa
    ["Llámame al 600111222", "Llámame al [telefono]"], // el teléfono se tapa entero, sin filtrar dígitos
    ["Mi reserva es BX1001", "Mi reserva es [reserva]"], // código sin guion
    ["Llegué el 2026-11-08 10:30", "Llegué el 2026-11-08 10:30"], // fecha y hora intactas
    ["Me recoge Sol en la terminal 12", "Me recoge [proveedor] en la terminal 12"], // referencia < 3 caracteres: no se toca
    ["Soy ana, de apellido garcia lopez", "Soy [nombre], de apellido [nombre] [nombre]"], // nombre del viajero, sin acentos ni mayúsculas
    ["Tel:600111222", "Tel:[telefono]"], // ":" pegado sin dígito delante no protege el número
    ["mi móvil es 600111222: llámame", "mi móvil es [telefono]: llámame"], // ":" detrás sin dígito tampoco
  ])("%s → %s", (input, expected) => expect(redactForLlm(input, sol)).toBe(expected));

  it("no tapa partículas del nombre (del, los…) sueltas en el texto", () => {
    const b2 = { codigo: "BX-1001", viajero_nombre: "María del Carmen de los Santos", servicios: [] };
    expect(redactForLlm("Soy maria carmen santos, cerca del hotel y los museos", b2)).toBe(
      "Soy [nombre] [nombre] [nombre], cerca del hotel y los museos",
    );
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
    const esc = (await db.select().from(incident_action)).find((a) => a.tipo === "escalado");
    expect(esc?.detalle).toMatchObject({ motivo: "clasificacion_fallida" });
  });

  it("emergencia sobre una incidencia ya escalada → la marca y vuelve a avisar a la guardia", async () => {
    const mails: Array<{ to: string; subject: string }> = [];
    const mailer: Mailer = { send: async (m) => { mails.push({ to: m.to, subject: m.subject }); return { messageId: "x" }; } };
    const { say, llm } = await setup({
      classify: [cls({ tipologia: "consulta", urgencia: "baja" })],
      converse: [{ ok: false, reason: "api_error", detail: "x" }],
    }, { mailer });
    await say("ana@example.com", "¿Hay wifi en el hotel?");
    expect(await inc()).toMatchObject({ estado: "escalado", urgencia: "baja" });
    await say("ana@example.com", "Mi hijo está sangrando mucho");
    expect(to("ana@example.com").at(-1)).toBe(EMERGENCY_REPLY);
    expect(await inc()).toMatchObject({ estado: "escalado", tipologia: "emergencia", urgencia: "critica", requiere_humano: true });
    const motivos = (await db.select().from(incident_action)).filter((a) => a.tipo === "escalado").map((a) => a.detalle);
    expect(motivos).toEqual([
      expect.objectContaining({ motivo: "llm_fallido" }),
      expect.objectContaining({ motivo: "emergencia", reaviso: true }),
    ]);
    const kpis = (await db.select().from(kpi_event)).filter((k) => k.tipo === "incidencia_escalada").map((k) => k.datos);
    expect(kpis).toContainEqual(expect.objectContaining({ motivo: "emergencia" }));
    expect(mails.map((m) => m.subject)).toEqual(["[BEXTIA] Incidencia escalada (llm_fallido)", "[BEXTIA] Incidencia escalada (emergencia)"]);
    expect(llm.calls.classify).toHaveLength(1);
  });

  it("error antes de crear la incidencia → no promete una persona y deja un KPI sin PII", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { say } = await setup({}, { agentDb: failingIncidentCreate });
    await say("ana@example.com", "El traslado no ha llegado");
    expect(to("ana@example.com")).toEqual([TEMPORARY_ERROR_REPLY]);
    expect(await db.select().from(incident)).toHaveLength(0);
    const k = (await db.select().from(kpi_event)).find((e) => e.tipo === "error_agente");
    expect(k?.datos).toEqual({ fase: "sin_incidencia", error: "TypeError" });
    for (const call of errors.mock.calls) expect(JSON.stringify(call)).not.toMatch(/ana@example\.com|traslado|fallo simulado/);
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

  it("recuperación: si el escalado lanza, marca requiere_humano y avisa una sola vez (M2)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failBoth = failingInsert(incident_action, (v) => v.tipo === "decision" || v.tipo === "escalado");
    const { say } = await setup({ classify: [cls()] }, { agentDb: failBoth });
    await say("ana@example.com", "El traslado no ha llegado");
    expect(await inc()).toMatchObject({ requiere_humano: true });
    expect(to("ana@example.com").filter((t) => t === ESCALATED_REPLY)).toHaveLength(1);
  });

  it("un error inesperado nunca se propaga al canal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { say } = await setup(); // guion vacío: classify lanza
    await expect(say("ana@example.com", "Tengo un problema")).resolves.toMatchObject({ status: "routed" });
    expect(await inc()).toMatchObject({ estado: "escalado", requiere_humano: true });
    expect(to("ana@example.com").at(-1)).toBe(ESCALATED_REPLY);
  });

  it("I1: consulta sin artículos KB → escala con sin_kb y no llama a converse", async () => {
    const { say, llm } = await setup({ classify: [cls({ tipologia: "consulta", urgencia: "baja" })] }, { kb: [] });
    await say("ana@example.com", "¿Hay piscina en el hotel?");
    expect(llm.calls.converse).toHaveLength(0);
    expect(await inc()).toMatchObject({ estado: "escalado", requiere_humano: true });
    const esc = (await db.select().from(incident_action)).find((a) => a.tipo === "escalado");
    expect(esc?.detalle).toMatchObject({ motivo: "sin_kb" });
    expect(to("ana@example.com").filter((t) => t === ESCALATED_REPLY)).toHaveLength(1);
  });

  it("I1: con artículos, el prompt pide responder solo con la KB y no promete contacto", async () => {
    const { say, llm } = await setup({
      classify: [cls({ tipologia: "consulta", urgencia: "baja" })],
      converse: [{ ok: true, value: "Desde las 15:00." }],
    });
    await say("ana@example.com", "¿A qué hora es el check-in?");
    const system = llm.calls.converse[0].system;
    expect(system).not.toMatch(/escribir[áa]n|contactar[áa]n|en breve/i);
    expect(system).toContain("no tienes esa información");
  });

  it("I6: error en el canal web → TEMPORARY_ERROR_REPLY queda en los mensajes de la conversación", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { say } = await setup({}, { agentDb: failingIncidentCreate });
    const out = await say("ana@example.com", "El traslado no ha llegado", "web");
    const msgs = await db.select().from(message).where(eq(message.conversation_id, out.conversationId));
    expect(msgs.filter((m) => m.direccion === "out").map((m) => m.contenido)).toEqual([TEMPORARY_ERROR_REPLY]);
  });

  it("I5: la respuesta del proveedor llega al LLM sin nombre del viajero, código ni proveedor", async () => {
    const { say, llm } = await setup({ classify: [cls(), { ok: true, value: { tipo: "desconocido", minutos: null } }] });
    await say("ana@example.com", "El traslado no ha llegado");
    await say("ops@translis.test", "Somos TransLis: ¿Ana García López sigue esperando? Reserva BX-1001");
    expect(llm.calls.classify).toHaveLength(2);
    const prompt = JSON.stringify(llm.calls.classify[1]);
    for (const s of ["TransLis", "Ana", "García", "López", "BX-1001"]) expect(prompt).not.toContain(s);
  });

  it("I4: «ya llegamos» del proveedor en seguimiento no va a leads ni responde", async () => {
    const { say } = await setup({ classify: [cls()] });
    await say("ana@example.com", "El traslado no ha llegado");
    await say("ops@translis.test", "20 min");
    expect((await inc()).estado).toBe("seguimiento");
    const before = sent.length;
    const out = await say("ops@translis.test", "Ya llegamos, gracias");
    expect(out.decision?.agent).toBe("incidents");
    expect(sent).toHaveLength(before);
    expect((await inc()).estado).toBe("seguimiento");
    const k = (await db.select().from(kpi_event)).find((e) => e.tipo === "mensaje_proveedor_descartado");
    expect(k?.datos).toEqual({ estado: "seguimiento" });
  });

  it("I4: el email del proveedor en mayúsculas coincide", async () => {
    const { say } = await setup({ classify: [cls()] });
    await say("ana@example.com", "El traslado no ha llegado");
    await say("OPS@TRANSLIS.TEST", "Llegamos en 20 min");
    expect(to("ana@example.com")).toContain("Buenas noticias: TransLis llega en unos 20 minutos a Aeropuerto LIS.");
    expect((await inc()).estado).toBe("seguimiento");
  });

  it("I3: dos viajeros con el mismo proveedor → ninguno avanza; ambos escalan con proveedor_ambiguo", async () => {
    const { say } = await setup({ classify: [cls(), cls()] });
    await db.insert(booking).values({
      codigo: "BX-1002", viajero_nombre: "Luis Pérez Gómez", destino: "Lisboa", viajero_email: "luis@example.com",
      inicio: new Date("2026-11-07T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
      servicios: [{ tipo: "traslado", proveedor: "TransLis", email: "ops@translis.test", inicio: "2026-11-08T10:00:00Z", lugar: "Aeropuerto LIS", referencia: "TL-78" }],
    });
    await say("ana@example.com", "El traslado no ha llegado");
    await say("luis@example.com", "El traslado no ha llegado");
    expect((await db.select().from(incident)).map((i) => i.estado)).toEqual(["protocolo", "protocolo"]);
    await say("ops@translis.test", "Llegamos en 20 min");
    const rows = await db.select().from(incident);
    expect(rows.map((i) => i.estado)).toEqual(["escalado", "escalado"]);
    for (const r of rows) expect(r.protocolo_estado?.terminado).toBe(true);
    for (const who of ["ana@example.com", "luis@example.com"]) {
      expect(to(who).filter((t) => t.startsWith("Buenas noticias"))).toHaveLength(0);
      expect(to(who).filter((t) => t === ESCALATED_REPLY)).toHaveLength(1);
    }
    const motivos = (await db.select().from(incident_action)).filter((a) => a.tipo === "escalado").map((a) => a.detalle.motivo);
    expect(motivos).toEqual(["proveedor_ambiguo", "proveedor_ambiguo"]);
  });

  it("decisión de leads → no hace nada", async () => {
    const { say } = await setup();
    await say("nuevo@example.com", "Quiero ir a Japón");
    expect(sent).toHaveLength(0);
    expect(await db.select().from(incident)).toHaveLength(0);
  });
});
