import type { KbHit } from "../rag/kb.ts";

export const ASK_NAME = "Para ayudarte con tu reserva necesito confirmar tu identidad: ¿cuál es el apellido del titular?";
export const NAME_MISMATCH = "Ese apellido no coincide con la reserva. ¿Puedes revisarlo y escribirlo de nuevo?";
export const IDENTIFIED_REPLY = "Gracias, ya te identificamos. Cuéntanos qué ocurre y te ayudamos.";
export const EMERGENCY_REPLY =
  "Si hay riesgo para tu salud o tu seguridad, llama ahora al 112 (o al número de emergencias local). Ya avisamos a nuestro equipo de guardia, que te contactará de inmediato.";
export const ESCALATED_REPLY = "Hemos pasado tu caso a una persona de nuestro equipo de guardia, que te escribirá en breve.";
export const ESCALATED_WAIT = "Tu caso ya está con nuestro equipo de guardia. Te escribirán en breve.";
export const PROTOCOL_IN_PROGRESS = "Seguimos gestionando tu caso con el proveedor. Te escribimos en cuanto tengamos novedades.";
export const FEEDBACK_THANKS = "¡Gracias por contarnos! Cerramos el caso. Si necesitas algo más, escríbenos cuando quieras.";

export function welcomeMessage(b: { viajero_nombre: string; destino: string }): string {
  const nombre = b.viajero_nombre.trim().split(/\s+/)[0] ?? "";
  return `¡Hola ${nombre}! Te damos la bienvenida a ${b.destino}. Somos el equipo de asistencia de BEXTIA y estamos disponibles 24/7 durante tu viaje: si surge cualquier imprevisto, escríbenos por aquí.`;
}

// Sin PII: solo el destino y los artículos KB. El historial va aparte como mensajes.
export function buildIncidentSystem(hits: KbHit[], destino: string): string {
  const kb = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${h.titulo}\n${h.contenido}`).join("\n\n")
    : "(sin artículos relevantes)";
  return [
    "Eres el asistente de viaje 24/7 de BEXTIA. El viajero está de viaje en: " + destino + ".",
    "Responde en el idioma del viajero, en 1 a 4 frases, con tono cercano y concreto.",
    "Usa solo la información de los artículos de abajo. Si no está ahí, di que lo consultas con el equipo y que le escribirán en breve.",
    "Nunca prometas reembolsos, montos, cambios de reserva ni compensaciones.",
    "Nunca pidas datos de pago ni contraseñas.",
    "",
    "Artículos:",
    kb,
  ].join("\n");
}

const NEGATIVE = /\b(mal|malo|mala|fatal|pesim\w*|horrible|terrible|queja\w*|reclam\w*|decepcion\w*|nadie)\b/;

export function isNegativeFeedback(text: string): boolean {
  const t = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return NEGATIVE.test(t);
}
