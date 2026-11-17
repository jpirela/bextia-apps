import { describe, expect, it } from "vitest";
import { createScriptedLlm } from "../llm/scripted.ts";
import { CASES, type EvalCase } from "./cases.ts";
import { matches, runCase } from "./score.ts";

describe("matches", () => {
  it("strings: contiene, sin tildes ni mayúsculas", () => {
    expect(matches({ destino: "japon" }, { destino: "Japón (Tokio y Kioto)" })).toEqual([]);
  });
  it("número, booleano y null", () => {
    expect(matches({ viajeros: 2, emocional: true, destino: null }, { viajeros: 3, emocional: true, destino: "" })).toEqual(["viajeros"]);
  });
  it("got nulo: todos los campos fallan", () => {
    expect(matches({ a: "x", b: 1 }, null)).toEqual(["a", "b"]);
  });
});

describe("runCase", () => {
  it("cualificación: puntúa solo los campos esperados", async () => {
    const llm = createScriptedLlm({ classify: [{ ok: true, value: { destino: "Japón", fecha_inicio: "2026-12-01", fecha_fin: "2026-12-12", viajeros: 2, interes: "cultura", urgencia: null, tipo: null, idioma: "es", nombre: null, email: null, telefono: null, pregunta: null } }] });
    const r = await runCase(llm, CASES.find((c) => c.id === "L01")!, "2026-11-07");
    expect(r).toMatchObject({ id: "L01", prompt: "cualificacion", ok: true, mismatches: [] });
  });
  it("incidencia: fallo del LLM queda como FALLA con got null", async () => {
    const llm = createScriptedLlm({ classify: [{ ok: false, reason: "api_error", detail: "x" }] });
    const r = await runCase(llm, CASES.find((c) => c.id === "I04")!, "2026-11-07");
    expect(r.ok).toBe(false);
    expect(r.got).toBeNull();
  });
  it("proveedor: usa la regex antes que el LLM", async () => {
    const llm = createScriptedLlm({});
    const c: EvalCase = { id: "PX", prompt: "proveedor", turns: [{ direccion: "in", contenido: "Lo sentimos, no podemos ir hoy" }], expected: { tipo: "rechazo" } };
    const r = await runCase(llm, c, "2026-11-07");
    expect(r.ok).toBe(true);
    expect(llm.calls.classify).toHaveLength(0);
  });
  it("hay 30 casos con ids únicos", () => {
    expect(CASES).toHaveLength(30);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(30);
  });
});
