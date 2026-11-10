import { describe, expect, it } from "vitest";
import { createScriptedLlm } from "../llm/scripted.ts";
import {
  buildTranscript, extractQualification, mergeQualification, missingFields, plainSummary, summarizeLead,
  type QualFacts, type Qualification,
} from "./qualify.ts";

const none: Qualification = {
  destino: null, fecha_inicio: null, fecha_fin: null, viajeros: null, interes: null, urgencia: null, tipo: null,
  idioma: null, nombre: null, email: null, telefono: null, pregunta: null,
};
const { pregunta: _p, ...noneFacts } = none;

describe("qualify", () => {
  it("transcripción etiqueta cliente y agente", () => {
    expect(buildTranscript([{ direccion: "in", contenido: "Hola" }, { direccion: "out", contenido: "¿Destino?" }]))
      .toBe("Cliente: Hola\nAgente: ¿Destino?");
  });

  it("extrae con classify, pasa la fecha de hoy y valida con Clark", async () => {
    const value = { ...none, destino: "Japón", viajeros: 2, urgencia: "media" };
    const llm = createScriptedLlm({ classify: [{ ok: true, value }] });
    const r = await extractQualification(llm, [{ direccion: "in", contenido: "Japón, 2 personas" }], "2026-11-07");
    expect(r).toEqual({ ok: true, value });
    expect(llm.calls.classify[0].input).toContain("2026-11-07");
    expect(llm.calls.classify[0].input).toContain("Cliente: Japón, 2 personas");
    expect(llm.calls.classify[0].jsonSchema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("merge conserva lo previo cuando lo nuevo es null", () => {
    const prev: QualFacts = { ...noneFacts, destino: "Japón", viajeros: 2 };
    expect(mergeQualification(prev, { ...none, viajeros: 3, interes: "cultura" }))
      .toMatchObject({ destino: "Japón", viajeros: 3, interes: "cultura" });
    expect(mergeQualification(prev, null)).toEqual(prev);
  });

  it("missingFields", () => {
    expect(missingFields(noneFacts, false)).toEqual(["destino", "fechas", "viajeros", "interes", "urgencia", "contacto"]);
    expect(missingFields({ ...noneFacts, destino: "x", fecha_inicio: "2026-12-01", fecha_fin: "2026-12-10", viajeros: 2, interes: "playa", urgencia: "baja" }, true)).toEqual([]);
  });

  it("summarizeLead usa el LLM y cae a resumen plano si falla", async () => {
    const facts: QualFacts = { ...noneFacts, destino: "Japón", viajeros: 2 };
    const ok = createScriptedLlm({ classify: [{ ok: true, value: { resumen: "Pareja a Japón." } }] });
    expect(await summarizeLead(ok, facts, [])).toBe("Pareja a Japón.");
    const bad = createScriptedLlm({ classify: [{ ok: false, reason: "api_error", detail: "500" }] });
    expect(await summarizeLead(bad, facts, [])).toBe(plainSummary(facts));
    expect(plainSummary(facts)).toContain("Destino: Japón");
  });
});
