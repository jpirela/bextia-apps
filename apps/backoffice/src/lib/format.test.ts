import { describe, expect, it } from "vitest";
import { formatDate, incidentTypeLabel, leadStateLabel, slaLabel } from "./format";

const NOW = new Date("2026-11-08T12:00:00Z");
describe("format", () => {
  it("fechas en la zona indicada", () => {
    expect(formatDate("2026-11-08T08:05:00Z", "Europe/Madrid")).toBe("08/11/2026 09:05");
    expect(formatDate(null)).toBe("—");
  });
  it("SLA", () => {
    expect(slaLabel("2026-11-08T11:50:00Z", NOW)).toEqual({ text: "vencido hace 10 min", intent: "danger" });
    expect(slaLabel("2026-11-08T12:10:00Z", NOW)).toEqual({ text: "vence en 10 min", intent: "warning" });
    expect(slaLabel("2026-11-08T14:00:00Z", NOW)).toEqual({ text: "vence en 120 min", intent: "success" });
    expect(slaLabel(null, NOW)).toEqual({ text: "sin SLA", intent: "subtle" });
  });
  it("etiquetas, con fallback al valor crudo", () => {
    expect(leadStateLabel("entregado")).toBe("Entregado");
    expect(leadStateLabel("cualificado")).toBe("Cualificado");
    expect(incidentTypeLabel("traslado_no_presentado")).toBe("Traslado no presentado");
    expect(incidentTypeLabel("raro")).toBe("raro");
  });
});
