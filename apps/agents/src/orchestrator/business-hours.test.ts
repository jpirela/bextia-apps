import { describe, expect, it } from "vitest";
import {
  InvalidBusinessHoursError, isWithinBusinessHours, parseWeeklyHours, ruleFromRow, type BusinessHoursRule,
} from "./business-hours.ts";

const madrid: BusinessHoursRule = {
  timezone: "Europe/Madrid",
  weekly: {
    mon: [["09:00", "14:00"], ["15:00", "18:00"]],
    tue: [["09:00", "18:00"]], wed: [["09:00", "18:00"]], thu: [["09:00", "18:00"]], fri: [["09:00", "15:00"]],
  },
  holidays: ["2026-12-08"],
};

describe("isWithinBusinessHours", () => {
  it("lunes 10:00 en Madrid está dentro", () => {
    expect(isWithinBusinessHours(madrid, new Date("2026-11-09T09:00:00Z"))).toBe(true);
  });
  it("la pausa de 14:00 a 15:00 está fuera", () => {
    expect(isWithinBusinessHours(madrid, new Date("2026-11-09T13:30:00Z"))).toBe(false);
  });
  it("18:00 exacto ya está fuera (cierre exclusivo)", () => {
    expect(isWithinBusinessHours(madrid, new Date("2026-11-09T17:00:00Z"))).toBe(false);
  });
  it("sábado está fuera", () => {
    expect(isWithinBusinessHours(madrid, new Date("2026-11-14T10:00:00Z"))).toBe(false);
  });
  it("festivo está fuera aunque sea martes laborable", () => {
    expect(isWithinBusinessHours(madrid, new Date("2026-12-08T10:00:00Z"))).toBe(false);
  });
  it("usa la zona horaria del mercado (Ciudad de México, UTC-6)", () => {
    const cdmx: BusinessHoursRule = { timezone: "America/Mexico_City", weekly: { mon: [["09:00", "18:00"]] }, holidays: [] };
    expect(isWithinBusinessHours(cdmx, new Date("2026-11-09T15:00:00Z"))).toBe(true);
    expect(isWithinBusinessHours(cdmx, new Date("2026-11-09T14:59:00Z"))).toBe(false);
  });
});

describe("parseWeeklyHours (P7)", () => {
  it("acepta rangos válidos", () => {
    expect(parseWeeklyHours({ mon: [["09:00", "14:00"], ["15:00", "18:00"]], sat: [] }))
      .toEqual({ mon: [["09:00", "14:00"], ["15:00", "18:00"]], sat: [] });
  });
  it.each([
    [{ mon: [["9:00", "18:00"]] }],
    [{ mon: [["09:00", "24:00"]] }],
    [{ mon: [["18:00", "09:00"]] }],
    [{ lunes: [["09:00", "18:00"]] }],
    [{ mon: "09:00-18:00" }],
    [null],
  ])("rechaza %j", (input) => {
    expect(() => parseWeeklyHours(input)).toThrow(InvalidBusinessHoursError);
  });
  it("rechaza zona horaria inexistente", () => {
    expect(() => ruleFromRow({ zona_horaria: "Europe/Nowhere", horario: { mon: [["09:00", "18:00"]] }, festivos: [] }))
      .toThrow(InvalidBusinessHoursError);
  });
});

describe("cambio de hora Europe/Madrid", () => {
  const rule = ruleFromRow({ zona_horaria: "Europe/Madrid", horario: { mon: [["09:00", "18:00"]], fri: [["09:00", "18:00"]] }, festivos: [] });
  it("viernes antes del cambio de marzo (CET, UTC+1)", () => {
    expect(isWithinBusinessHours(rule, new Date("2026-03-27T08:30:00Z"))).toBe(true);
    expect(isWithinBusinessHours(rule, new Date("2026-03-27T07:30:00Z"))).toBe(false);
  });
  it("lunes después del cambio de marzo (CEST, UTC+2)", () => {
    expect(isWithinBusinessHours(rule, new Date("2026-03-30T07:30:00Z"))).toBe(true);
    expect(isWithinBusinessHours(rule, new Date("2026-03-30T06:30:00Z"))).toBe(false);
  });
  it("lunes después del cambio de octubre (CET, UTC+1)", () => {
    expect(isWithinBusinessHours(rule, new Date("2026-10-26T08:30:00Z"))).toBe(true);
    expect(isWithinBusinessHours(rule, new Date("2026-10-26T07:30:00Z"))).toBe(false);
  });
});