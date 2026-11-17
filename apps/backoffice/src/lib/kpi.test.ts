import { describe, expect, it } from "vitest";
import { median, rangeQuery, summarize } from "./kpi";

describe("kpi", () => {
  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it("summarize", () => {
    const s = summarize({
      rango: { desde: "2026-11-01T00:00:00Z", hasta: "2026-11-08T00:00:00Z" },
      eventos: [
        { tipo: "first_response", agente: "leads", canal: "web", valor: 4, created_at: "2026-11-02T10:00:00Z" },
        { tipo: "first_response", agente: "leads", canal: "whatsapp", valor: 10, created_at: "2026-11-02T11:00:00Z" },
        { tipo: "first_response", agente: "incidencias", canal: "whatsapp", valor: 6, created_at: "2026-11-03T11:00:00Z" },
      ],
      leads: [
        { estado: "entregado", score: 80, mercado: "ES", created_at: "2026-11-02T10:00:00Z", entregado_at: "2026-11-02T12:00:00Z" },
        { estado: "nuevo", score: null, mercado: "ES", created_at: "2026-11-03T10:00:00Z", entregado_at: null },
      ],
      incidencias: [
        { tipologia: "traslado_no_presentado", urgencia: "alta", estado: "cerrado", requiere_humano: false, created_at: "2026-11-02T10:00:00Z", cerrado_at: "2026-11-02T10:40:00Z" },
        { tipologia: "consulta", urgencia: "baja", estado: "escalado", requiere_humano: true, created_at: "2026-11-03T10:00:00Z", cerrado_at: null },
      ],
    });
    expect(s).toMatchObject({ leads: 2, entregados: 1, tasaEntrega: 0.5, scoreMedio: 80, incidencias: 2, abiertas: 1, escaladas: 1, primeraRespuestaP50: 6, resolucionMedianaMin: 40 });
    expect(s.porDia).toEqual([{ dia: "2026-11-02", leads: 1, incidencias: 1 }, { dia: "2026-11-03", leads: 1, incidencias: 1 }]);
    expect(s.porCanal).toEqual([{ canal: "whatsapp", n: 2 }, { canal: "web", n: 1 }]);
    expect(s.porTipologia).toEqual(expect.arrayContaining([{ tipologia: "consulta", n: 1 }]));
  });
  it("sin datos no divide por cero", () => {
    expect(summarize({ rango: { desde: "", hasta: "" }, eventos: [], leads: [], incidencias: [] })).toMatchObject({ tasaEntrega: null, scoreMedio: null, primeraRespuestaP50: null, resolucionMedianaMin: null });
  });
  it("rangeQuery hace el último día inclusivo", () => {
    expect(rangeQuery({ from: "2026-11-01", to: "2026-11-30" })).toEqual({ desde: "2026-11-01", hasta: "2026-12-01" });
  });
});
