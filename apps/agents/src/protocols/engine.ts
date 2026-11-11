import { render, templateVars } from "./render.ts";
import type { ProtocolAction, ProtocolContext, ProtocolDef, ProtocolEvent, ProtocolState } from "./types.ts";

export const MAX_STEPS = 20;

export interface AdvanceResult { state: ProtocolState | null; actions: ProtocolAction[] }

// Función pura: no toca la BD ni el reloj (ctx.now). El runner ejecuta las acciones.
export function advance(def: ProtocolDef, state: ProtocolState | null, event: ProtocolEvent, ctx: ProtocolContext): AdvanceResult {
  if (event.tipo === "inicio") {
    if (state) return { state, actions: [] };
    return run(def, { paso: def.inicio, espera_hasta: null, eta_min: null, autorizado: null, terminado: false }, ctx);
  }
  if (!state || state.terminado) return { state, actions: [] };
  const step = def.pasos[state.paso];
  if (step?.tipo !== "esperar_respuesta") return { state, actions: [] };
  if (event.tipo === "respuesta_proveedor" && Number.isInteger(event.eta_min) && event.eta_min! >= 1 && event.eta_min! <= step.max_eta_min) {
    return run(def, { ...state, espera_hasta: null, eta_min: event.eta_min, paso: step.si_responde }, ctx);
  }
  return run(def, { ...state, espera_hasta: null, paso: step.si_vence }, ctx);
}

function run(def: ProtocolDef, start: ProtocolState, ctx: ProtocolContext): AdvanceResult {
  const s: ProtocolState = { ...start };
  const actions: ProtocolAction[] = [];
  const say = (plantilla: string) => render(def.plantillas[plantilla], templateVars(ctx, { eta: s.eta_min, monto: s.autorizado }));
  const end = (a: ProtocolAction): AdvanceResult => { actions.push(a); s.terminado = true; return { state: s, actions }; };

  for (let i = 0; i < MAX_STEPS; i++) {
    const step = def.pasos[s.paso];
    switch (step.tipo) {
      case "verificar_servicio": {
        const sv = ctx.servicio;
        const ok = sv?.tipo === "traslado" && Boolean(sv.telefono || sv.email);
        actions.push({ tipo: "decision", detalle: { paso: s.paso, verificacion: ok ? "ok" : "falla" } });
        s.paso = ok ? step.si_ok : step.si_falla;
        break;
      }
      case "contactar_proveedor":
        actions.push({ tipo: "enviar_proveedor", texto: say(step.plantilla) });
        s.paso = step.siguiente;
        break;
      case "mensaje_viajero":
        actions.push({ tipo: "enviar_viajero", texto: say(step.plantilla) });
        s.paso = step.siguiente;
        break;
      case "esperar_respuesta": {
        const at = new Date(ctx.now.getTime() + step.minutos * 60_000);
        s.espera_hasta = at.toISOString();
        actions.push({ tipo: "programar", at });
        return { state: s, actions };
      }
      case "autorizar_gasto":
        if (s.autorizado != null) return end({ tipo: "escalar", motivo: "doble_autorizacion" });
        if (!(ctx.tope > 0)) return end({ tipo: "escalar", motivo: "sin_tope" });
        s.autorizado = ctx.tope;
        actions.push({ tipo: "autorizar", monto: ctx.tope, concepto: step.concepto });
        s.paso = step.siguiente;
        break;
      case "pedir_feedback":
        return end({ tipo: "feedback", texto: say(step.plantilla) });
      case "escalar":
        return end({ tipo: "escalar", motivo: step.motivo });
    }
  }
  return end({ tipo: "escalar", motivo: "max_pasos" });
}
