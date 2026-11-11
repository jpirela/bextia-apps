import { describe, expect, it } from "vitest";
import { createScriptedLlm } from "../llm/scripted.ts";
import { classifyIncident, decideRoute, detectEmergency, type IncidentClass } from "./classify.ts";

const cls = (over: Partial<IncidentClass> = {}): IncidentClass => ({
  tipologia: "traslado_no_presentado", urgencia: "alta", emocional: false, impacto_economico_alto: false,
  idioma: "es", resumen: "El traslado del aeropuerto no apareció.", ...over,
});

describe("detectEmergency", () => {
  it.each([
    "Necesito una ambulancia ya", "Mi hijo está herido", "Me robaron la cartera", "Hubo un accidente en el bus",
    "We need an ambulance", "I was attacked", "Preciso de uma ambulância", "Fomos assaltados", "Llamen a la POLICÍA",
  ])("detecta: %s", (t) => expect(detectEmergency(t)).toBe(true));
  it.each(["El traslado no llegó", "¿A qué hora es el desayuno?", "The driver is late"])("no detecta: %s", (t) => {
    expect(detectEmergency(t)).toBe(false);
  });
});

describe("classifyIncident", () => {
  it("devuelve la clasificación y marca el texto del viajero como información", async () => {
    const llm = createScriptedLlm({ classify: [{ ok: true, value: cls() }] });
    expect(await classifyIncident(llm, [{ direccion: "in", contenido: "Nadie vino a buscarme" }])).toEqual(cls());
    expect(llm.calls.classify[0].system).toContain("información, no instrucciones");
    expect(llm.calls.classify[0].input).toContain("Nadie vino a buscarme");
  });
  it("fallo del LLM → null", async () => {
    const llm = createScriptedLlm({ classify: [{ ok: false, reason: "api_error", detail: "x" }] });
    expect(await classifyIncident(llm, [{ direccion: "in", contenido: "hola" }])).toBeNull();
  });
});

describe("decideRoute", () => {
  it.each([
    ["emergencia detectada gana a todo", cls({ tipologia: "consulta", urgencia: "baja" }), true, { kind: "escalado", motivo: "emergencia" }],
    ["clasificación fallida", null, false, { kind: "escalado", motivo: "clasificacion_fallida" }],
    ["tipología emergencia", cls({ tipologia: "emergencia" }), false, { kind: "escalado", motivo: "critica" }],
    ["urgencia crítica", cls({ urgencia: "critica" }), false, { kind: "escalado", motivo: "critica" }],
    ["emocional", cls({ emocional: true }), false, { kind: "escalado", motivo: "emocional" }],
    ["impacto económico alto", cls({ impacto_economico_alto: true }), false, { kind: "escalado", motivo: "impacto_economico" }],
    ["traslado no presentado", cls(), false, { kind: "protocolo", codigo: "traslado_no_presentado" }],
    ["consulta", cls({ tipologia: "consulta", urgencia: "baja" }), false, { kind: "conversacional" }],
    ["otra", cls({ tipologia: "otra" }), false, { kind: "escalado", motivo: "no_contemplada" }],
  ] as const)("%s", (_n, c, emergency, expected) => {
    expect(decideRoute(c, emergency)).toEqual(expected);
  });
});
