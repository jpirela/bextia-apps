import type { BookingService } from "../db/schema.ts";

// Minúsculas sin marcas diacríticas.
export const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// Guardarraíl de privacidad: al LLM (y a la búsqueda KB) no llegan email, teléfono, código de reserva,
// nombre del viajero ni nombre/referencia del proveedor, aunque aparezcan en el historial (los escribió
// el viajero o están en mensajes salientes de protocolos anteriores) o en la respuesta del proveedor.
const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
// Secuencia de dígitos completa: no empieza ni acaba pegada a otro dígito ni dentro de una hora
// ("10:30"); un ":" que no esté entre dígitos ("Tel:600111222", "600111222: llámame") no la protege.
const PHONE_RE = /(?<!\d|\d:)\+?\d(?:[\s().-]?\d){6,16}(?!\d|:\d)/g;
// Forma de BOOKING_CODE, con y sin guion (BX-1001, BX1001).
const CODE_RE = /(?<![\p{L}\p{N}])[a-z]{2,4}-?\d{4,8}(?![\p{L}\p{N}])/giu;
const MIN_TOKEN = 3;
// Partículas de nombres compuestos: solas no identifican a nadie y son palabras comunes del texto.
const NAME_PARTICLES = new Set(["del", "las", "los", "dos", "das", "van", "von", "der", "den", "des", "die"]);
const ACCENTS: Record<string, string> = { a: "aáàâäã", e: "eéèêë", i: "iíìîï", o: "oóòôöõ", u: "uúùûü", n: "nñ", c: "cç" };

// Término literal con fronteras de palabra Unicode, insensible a mayúsculas y acentos.
function termRe(term: string): RegExp {
  const body = [...norm(term)].map((ch) =>
    ACCENTS[ch] ? `[${ACCENTS[ch]}]` : /\s/.test(ch) ? "\\s+" : ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
  ).join("");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

export interface RedactBooking { codigo: string; viajero_nombre?: string | null; servicios: unknown }

export function redactForLlm(text: string, b: RedactBooking): string {
  const servicios = (Array.isArray(b.servicios) ? b.servicios : []) as BookingService[];
  const long = (x: unknown): x is string => typeof x === "string" && x.trim().length >= MIN_TOKEN;
  // Primero email y teléfono: ningún reemplazo posterior puede partir una secuencia de dígitos.
  let out = text.replace(EMAIL_RE, "[email]");
  // Teléfono: con prefijo + o con al menos 9 dígitos (no tapa horas, fechas ni importes cortos).
  out = out.replace(PHONE_RE, (m) => (m.startsWith("+") || m.replace(/\D/g, "").length >= 9 ? "[telefono]" : m));
  out = out.replace(CODE_RE, "[reserva]");
  for (const c of [b.codigo, b.codigo.replace(/-/g, "")].filter(long)) out = out.replace(termRe(c.trim()), "[reserva]");
  for (const s of servicios) {
    if (long(s.proveedor)) out = out.replace(termRe(s.proveedor.trim()), "[proveedor]");
    if (long(s.referencia)) out = out.replace(termRe(s.referencia.trim()), "[referencia]");
  }
  for (const t of (b.viajero_nombre ?? "").split(/[^\p{L}]+/u)
    .filter((x) => x.length >= MIN_TOKEN && !NAME_PARTICLES.has(norm(x)))) {
    out = out.replace(termRe(t), "[nombre]");
  }
  return out;
}
