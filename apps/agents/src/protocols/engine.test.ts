import { describe, expect, it } from "vitest";
import { advance, MAX_STEPS } from "./engine.ts";
import { parseProtocol } from "./parse.ts";
import { loadDefaultDefinition } from "./seed.ts";
import type { ProtocolContext } from "./types.ts";

const def = parseProtocol(loadDefaultDefinition());
const now = new Date("2026-11-08T10:05:00Z");
const ctx = (over: Partial<ProtocolContext> = {}): ProtocolContext => ({
  now, tope: 40, moneda: "EUR",
  booking: { codigo: "BX-1001", viajero_nombre: "Ana García" },
  servicio: { tipo: "traslado", proveedor: "TransLis", telefono: "+351910000000", inicio: "2026-11-08T10:00:00Z", lugar: "Aeropuerto LIS", referencia: "TL-77" },
  ...over,
});

describe("advance", () => {
  it("inicio: verifica, contacta, avisa y programa la espera de 15 min", () => {
    const r = advance(def, null, { tipo: "inicio" }, ctx());
    expect(r.actions.map((a) => a.tipo)).toEqual(["decision", "enviar_proveedor", "enviar_viajero", "programar"]);
    expect(r.actions[1]).toMatchObject({ texto: expect.stringContaining("TL-77") });
    expect(r.actions[1]).toMatchObject({ texto: expect.stringContaining("10:00 UTC") });
    expect(r.actions[2]).toMatchObject({ texto: "Ana, ya estamos contactando a TransLis. Te escribimos en un máximo de 15 minutos." });
    expect(r.actions[3]).toEqual({ tipo: "programar", at: new Date("2026-11-08T10:20:00Z") });
    expect(r.state).toEqual({ paso: "esperar", espera_hasta: "2026-11-08T10:20:00.000Z", eta_min: null, autorizado: null, terminado: false });
  });

  it("inicio repetido no hace nada", () => {
    const first = advance(def, null, { tipo: "inicio" }, ctx());
    expect(advance(def, first.state, { tipo: "inicio" }, ctx()).actions).toEqual([]);
  });

  it("el proveedor responde con ETA dentro del máximo → confirma y pide feedback", () => {
    const { state } = advance(def, null, { tipo: "inicio" }, ctx());
    const r = advance(def, state, { tipo: "respuesta_proveedor", eta_min: 20 }, ctx());
    expect(r.actions).toEqual([
      { tipo: "enviar_viajero", texto: "Buenas noticias: TransLis llega en unos 20 minutos a Aeropuerto LIS." },
      { tipo: "feedback", texto: "Cuando estés en el hotel, cuéntanos en una frase cómo fue todo." },
    ]);
    expect(r.state).toMatchObject({ eta_min: 20, terminado: true, espera_hasta: null });
  });

  it.each([
    ["vence la espera", { tipo: "vencimiento" } as const],
    ["ETA mayor al máximo", { tipo: "respuesta_proveedor", eta_min: 45 } as const],
    ["el proveedor rechaza", { tipo: "respuesta_proveedor", eta_min: null } as const],
  ])("%s → autoriza taxi por el tope", (_n, event) => {
    const { state } = advance(def, null, { tipo: "inicio" }, ctx());
    const r = advance(def, state, event, ctx());
    expect(r.actions).toEqual([
      { tipo: "autorizar", monto: 40, concepto: "taxi" },
      { tipo: "enviar_viajero", texto: "TransLis no confirmó a tiempo. Toma un taxi oficial hasta tu hotel: te reembolsamos hasta 40.00 EUR. Guarda el recibo." },
      { tipo: "feedback", texto: "Cuando estés en el hotel, cuéntanos en una frase cómo fue todo." },
    ]);
    expect(r.state).toMatchObject({ autorizado: 40, terminado: true });
  });

  it("sin servicio verificable → escala", () => {
    const r = advance(def, null, { tipo: "inicio" }, ctx({ servicio: null }));
    expect(r.actions).toEqual([
      { tipo: "decision", detalle: { paso: "verificar", verificacion: "falla" } },
      { tipo: "escalar", motivo: "servicio_no_verificable" },
    ]);
    expect(r.state?.terminado).toBe(true);
  });

  it("sin tope configurado → escala en vez de autorizar", () => {
    const { state } = advance(def, null, { tipo: "inicio" }, ctx({ tope: 0 }));
    const r = advance(def, state, { tipo: "vencimiento" }, ctx({ tope: 0 }));
    expect(r.actions).toEqual([{ tipo: "escalar", motivo: "sin_tope" }]);
  });

  it("eventos fuera de una espera o tras terminar no hacen nada", () => {
    expect(advance(def, null, { tipo: "vencimiento" }, ctx())).toEqual({ state: null, actions: [] });
    const done = advance(def, null, { tipo: "inicio" }, ctx({ servicio: null })).state;
    expect(advance(def, done, { tipo: "vencimiento" }, ctx()).actions).toEqual([]);
  });

  it("un ciclo sin esperas se corta en MAX_STEPS y escala", () => {
    const loop = parseProtocol({
      codigo: "loop", nombre: "Loop", inicio: "a",
      pasos: { a: { tipo: "mensaje_viajero", plantilla: "t", siguiente: "b" }, b: { tipo: "mensaje_viajero", plantilla: "t", siguiente: "a" } },
      plantillas: { t: "hola" },
    });
    const r = advance(loop, null, { tipo: "inicio" }, ctx());
    expect(r.actions).toHaveLength(MAX_STEPS + 1);
    expect(r.actions.at(-1)).toEqual({ tipo: "escalar", motivo: "max_pasos" });
  });
});
