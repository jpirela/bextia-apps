import type { BookingService, ProtocolState } from "../db/schema.ts";

export type { ProtocolState };

export type Step =
  | { tipo: "verificar_servicio"; si_ok: string; si_falla: string }
  | { tipo: "contactar_proveedor"; plantilla: string; siguiente: string }
  | { tipo: "esperar_respuesta"; minutos: number; max_eta_min: number; si_responde: string; si_vence: string }
  | { tipo: "autorizar_gasto"; concepto: string; siguiente: string }
  | { tipo: "mensaje_viajero"; plantilla: string; siguiente: string }
  | { tipo: "pedir_feedback"; plantilla: string }
  | { tipo: "escalar"; motivo: string };
export type StepType = Step["tipo"];

export interface ProtocolDef {
  codigo: string;
  nombre: string;
  inicio: string;
  pasos: Record<string, Step>;
  plantillas: Record<string, string>;
}

export type ProtocolEvent =
  | { tipo: "inicio" }
  | { tipo: "respuesta_proveedor"; eta_min: number | null } // null = rechazo
  | { tipo: "vencimiento" };

export type ProtocolAction =
  | { tipo: "enviar_viajero"; texto: string }
  | { tipo: "enviar_proveedor"; texto: string }
  | { tipo: "programar"; at: Date }
  | { tipo: "autorizar"; monto: number; concepto: string }
  | { tipo: "decision"; detalle: Record<string, unknown> }
  | { tipo: "escalar"; motivo: string }
  | { tipo: "feedback"; texto: string };

export interface ProtocolContext {
  now: Date;
  tope: number; // protocol.tope_autorizado: la única fuente del monto
  moneda: string;
  booking: { codigo: string; viajero_nombre: string };
  servicio: BookingService | null;
}

// Único patrón de variables: lo comparten el parser y el render.
export const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;
export const PLACEHOLDERS = ["viajero", "codigo", "proveedor", "lugar", "hora", "referencia", "eta", "monto", "moneda"] as const;
