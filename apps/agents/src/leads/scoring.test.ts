import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING, parseScoringRules, scoreLead, type LeadFacts } from "./scoring.ts";

const now = new Date("2026-11-07T12:00:00Z");
const empty: LeadFacts = { destino: null, fecha_inicio: null, fecha_fin: null, viajeros: null, interes: null, urgencia: null, tipo: null, tieneContacto: false };
const full: LeadFacts = { destino: "Japón", fecha_inicio: "2026-11-20", fecha_fin: "2026-11-30", viajeros: 8, interes: "cultura", urgencia: "alta", tipo: "grupo", tieneContacto: true };

describe("scoreLead", () => {
  it("lead vacío = 0", () => expect(scoreLead(empty, now)).toBe(0));
  it("lead completo, urgente, próximo, grupo = 100", () => expect(scoreLead(full, now)).toBe(100));
  it("fechas requieren inicio y fin", () => {
    expect(scoreLead({ ...empty, fecha_inicio: "2026-11-20" }, now)).toBe(15); // solo proximidad
    expect(scoreLead({ ...empty, fecha_inicio: "2026-11-20", fecha_fin: "2026-11-25" }, now)).toBe(30);
  });
  it.each([["2026-12-01", 15], ["2027-01-20", 10], ["2027-04-01", 5], ["2027-09-01", 0], ["2026-10-01", 0]])(
    "proximidad de %s = %i", (fecha, pts) => expect(scoreLead({ ...empty, fecha_inicio: fecha }, now)).toBe(pts),
  );
  it("nunca supera 100 con reglas infladas", () => {
    const rules = { ...DEFAULT_SCORING, grupo: { minViajeros: 2, puntos: 50 } };
    expect(scoreLead(full, now, rules)).toBe(100);
  });
});

describe("parseScoringRules", () => {
  it("mezcla con los valores por defecto", () => {
    const r = parseScoringRules('{"urgencia":{"alta":20}}');
    expect(r.urgencia).toEqual({ baja: 0, media: 8, alta: 20 });
    expect(r.completeness).toEqual(DEFAULT_SCORING.completeness);
  });
  it("rechaza números negativos o no numéricos", () => {
    expect(() => parseScoringRules('{"urgencia":{"alta":-1}}')).toThrow(/SCORING_RULES_JSON/);
    expect(() => parseScoringRules('{"grupo":{"puntos":"x"}}')).toThrow(/SCORING_RULES_JSON/);
    expect(() => parseScoringRules("no-json")).toThrow(/SCORING_RULES_JSON/);
  });
});
