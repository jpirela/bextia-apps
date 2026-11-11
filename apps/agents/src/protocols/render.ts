import { PLACEHOLDER_RE, type ProtocolContext } from "./types.ts";

export function templateVars(ctx: ProtocolContext, extra: { eta?: number | null; monto?: number | null } = {}): Record<string, string> {
  const s = ctx.servicio;
  return {
    viajero: ctx.booking.viajero_nombre.trim().split(/\s+/)[0] ?? "",
    codigo: ctx.booking.codigo,
    proveedor: s?.proveedor ?? "",
    lugar: s?.lugar ?? "",
    hora: s?.inicio?.slice(11, 16) ?? "", // hora UTC del ISO del servicio
    referencia: s?.referencia ?? "",
    eta: extra.eta == null ? "" : String(extra.eta),
    monto: extra.monto == null ? "" : extra.monto.toFixed(2),
    moneda: ctx.moneda,
  };
}

export function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(PLACEHOLDER_RE, (_m, k: string) => (Object.hasOwn(vars, k) ? vars[k] : ""));
}
