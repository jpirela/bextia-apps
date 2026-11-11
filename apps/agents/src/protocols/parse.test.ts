import { describe, expect, it } from "vitest";
import { InvalidProtocolError, parseProtocol } from "./parse.ts";
import { loadDefaultDefinition } from "./seed.ts";

const base = () => structuredClone(loadDefaultDefinition()) as any;

describe("parseProtocol", () => {
  it("acepta la definición de traslado no presentado", () => {
    const def = parseProtocol(base());
    expect(def.codigo).toBe("traslado_no_presentado");
    expect(def.inicio).toBe("verificar");
    expect(Object.keys(def.pasos)).toHaveLength(9);
  });
  it.each([
    ["tipo fuera de la lista blanca", (d: any) => { d.pasos.verificar.tipo = "ejecutar_sql"; }],
    ["referencia a paso inexistente", (d: any) => { d.pasos.contactar.siguiente = "nada"; }],
    ["plantilla inexistente", (d: any) => { d.pasos.avisar.plantilla = "nada"; }],
    ["variable no permitida", (d: any) => { d.plantillas.aviso = "Hola {{telefono}}"; }],
    ["minutos fuera de rango", (d: any) => { d.pasos.esperar.minutos = 0; }],
    ["max_eta_min no entero", (d: any) => { d.pasos.esperar.max_eta_min = 12.5; }],
    ["monto en un paso (el LLM/JSON no decide montos)", (d: any) => { d.pasos.autorizar.monto = 500; }],
    ["inicio inexistente", (d: any) => { d.inicio = "nada"; }],
    ["paso __proto__", (d: any) => { d.pasos = JSON.parse('{"__proto__": {"tipo": "escalar", "motivo": "x"}}'); d.inicio = "__proto__"; }],
  ])("rechaza: %s", (_name, mutate) => {
    const d = base();
    mutate(d);
    expect(() => parseProtocol(d)).toThrow(InvalidProtocolError);
  });
  it("rechaza lo que no es objeto", () => {
    expect(() => parseProtocol(null)).toThrow(InvalidProtocolError);
    expect(() => parseProtocol("[]")).toThrow(InvalidProtocolError);
  });
});
