import { describe, expect, it } from "vitest";
import { isWithinBusinessHours, type BusinessHoursRule } from "./business-hours.ts";

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
