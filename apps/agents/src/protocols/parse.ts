import { PLACEHOLDER_RE, PLACEHOLDERS, type ProtocolDef, type Step, type StepType } from "./types.ts";

export class InvalidProtocolError extends Error {
  override name = "InvalidProtocolError";
}

// Forma exacta de cada tipo de paso: cualquier otro campo (p. ej. un monto) se rechaza.
const SHAPE: Record<StepType, { refs: string[]; plantilla?: boolean; codes?: string[]; ints?: Record<string, [number, number]> }> = {
  verificar_servicio: { refs: ["si_ok", "si_falla"] },
  contactar_proveedor: { refs: ["siguiente"], plantilla: true },
  esperar_respuesta: { refs: ["si_responde", "si_vence"], ints: { minutos: [1, 120], max_eta_min: [1, 240] } },
  autorizar_gasto: { refs: ["siguiente"], codes: ["concepto"] },
  mensaje_viajero: { refs: ["siguiente"], plantilla: true },
  pedir_feedback: { refs: [], plantilla: true },
  escalar: { refs: [], codes: ["motivo"] },
};
const STEP_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const CODE = /^[a-z][a-z0-9_]{0,39}$/;


function fail(msg: string): never {
  throw new InvalidProtocolError(msg);
}
function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(`${what}: se esperaba un objeto`);
  return v as Record<string, unknown>;
}
function str(v: unknown, what: string, max = 1000): string {
  if (typeof v !== "string" || v.trim() === "" || v.length > max) fail(`${what}: texto inválido`);
  return v;
}

export function parseProtocol(raw: unknown): ProtocolDef {
  const o = obj(raw, "definición");
  const codigo = str(o.codigo, "codigo", 60);
  if (!CODE.test(codigo)) fail("codigo: formato inválido");
  const nombre = str(o.nombre, "nombre", 120);
  const inicio = str(o.inicio, "inicio", 40);
  const pasosRaw = obj(o.pasos, "pasos");
  const plantillasRaw = obj(o.plantillas, "plantillas");

  const plantillas: Record<string, string> = {};
  for (const [k, v] of Object.entries(plantillasRaw)) {
    if (!STEP_NAME.test(k)) fail(`plantilla ${k}: nombre inválido`);
    const t = str(v, `plantilla ${k}`);
    for (const m of t.matchAll(PLACEHOLDER_RE)) {
      if (!(PLACEHOLDERS as readonly string[]).includes(m[1])) fail(`plantilla ${k}: variable {{${m[1]}}} no permitida`);
    }
    plantillas[k] = t;
  }

  const names = Object.keys(pasosRaw);
  if (names.length === 0 || names.length > 30) fail("pasos: entre 1 y 30");
  const pasos: Record<string, Step> = Object.create(null);
  for (const name of names) {
    if (!STEP_NAME.test(name)) fail(`paso ${name}: nombre inválido`);
    const p = obj(pasosRaw[name], `paso ${name}`);
    const tipo = p.tipo;
    if (typeof tipo !== "string" || !Object.hasOwn(SHAPE, tipo)) fail(`paso ${name}: tipo no permitido`);
    const shape = SHAPE[tipo as StepType];
    const allowed = new Set(["tipo", ...shape.refs, ...(shape.codes ?? []), ...Object.keys(shape.ints ?? {}), ...(shape.plantilla ? ["plantilla"] : [])]);
    for (const k of Object.keys(p)) if (!allowed.has(k)) fail(`paso ${name}: campo ${k} no permitido`);
    for (const r of shape.refs) {
      const target = str(p[r], `paso ${name}.${r}`, 40);
      if (!Object.hasOwn(pasosRaw, target)) fail(`paso ${name}.${r}: paso ${target} inexistente`);
    }
    for (const c of shape.codes ?? []) if (!CODE.test(str(p[c], `paso ${name}.${c}`, 40))) fail(`paso ${name}.${c}: formato inválido`);
    for (const [k, [min, max]] of Object.entries(shape.ints ?? {})) {
      const n = p[k];
      if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) fail(`paso ${name}.${k}: entero entre ${min} y ${max}`);
    }
    if (shape.plantilla && !Object.hasOwn(plantillas, str(p.plantilla, `paso ${name}.plantilla`, 40))) {
      fail(`paso ${name}: plantilla ${String(p.plantilla)} inexistente`);
    }
    pasos[name] = p as unknown as Step;
  }
  if (!Object.hasOwn(pasos, inicio)) fail(`inicio: paso ${inicio} inexistente`);
  return { codigo, nombre, inicio, pasos, plantillas };
}
