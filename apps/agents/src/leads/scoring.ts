import type { LeadType, Urgency } from "../db/schema.ts";

export interface LeadFacts {
  destino: string | null; fecha_inicio: string | null; fecha_fin: string | null; viajeros: number | null;
  interes: string | null; urgencia: Urgency | null; tipo: LeadType | null; tieneContacto: boolean;
}

export interface ScoringRules {
  completeness: { destino: number; fechas: number; viajeros: number; interes: number; contacto: number };
  urgencia: Record<Urgency, number>;
  proximidad: Array<{ maxDias: number; puntos: number }>; // ascendente por maxDias
  grupo: { minViajeros: number; puntos: number };
  tipo: Partial<Record<LeadType, number>>;
}

// Máximo por defecto: 60 (completitud) + 15 (urgencia) + 15 (proximidad) + 5 (grupo) + 5 (tipo) = 100.
export const DEFAULT_SCORING: ScoringRules = {
  completeness: { destino: 15, fechas: 15, viajeros: 10, interes: 10, contacto: 10 },
  urgencia: { baja: 0, media: 8, alta: 15 },
  proximidad: [{ maxDias: 30, puntos: 15 }, { maxDias: 90, puntos: 10 }, { maxDias: 180, puntos: 5 }],
  grupo: { minViajeros: 6, puntos: 5 },
  tipo: { luna_de_miel: 5, grupo: 5, corporativo: 5 },
};

const DAY_MS = 86_400_000;

function daysUntil(isoDate: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((start - today) / DAY_MS);
}

export function scoreLead(f: LeadFacts, now: Date, rules: ScoringRules = DEFAULT_SCORING): number {
  const c = rules.completeness;
  let s = 0;
  if (f.destino) s += c.destino;
  if (f.fecha_inicio && f.fecha_fin) s += c.fechas;
  if (f.viajeros) s += c.viajeros;
  if (f.interes) s += c.interes;
  if (f.tieneContacto) s += c.contacto;
  if (f.urgencia) s += rules.urgencia[f.urgencia] ?? 0;
  if (f.fecha_inicio) {
    const d = daysUntil(f.fecha_inicio, now);
    if (d !== null && d >= 0) s += rules.proximidad.find((p) => d <= p.maxDias)?.puntos ?? 0;
  }
  if (f.viajeros && f.viajeros >= rules.grupo.minViajeros) s += rules.grupo.puntos;
  if (f.tipo) s += rules.tipo[f.tipo] ?? 0;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function fail(detail: string): never {
  throw new Error(`SCORING_RULES_JSON inválido: ${detail}`);
}

function checkNumbers(obj: unknown, path: string): void {
  if (typeof obj === "number") { if (!Number.isFinite(obj) || obj < 0) fail(`${path} debe ser un número ≥ 0`); return; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => checkNumbers(v, `${path}[${i}]`)); return; }
  if (obj && typeof obj === "object") { for (const [k, v] of Object.entries(obj)) checkNumbers(v, path ? `${path}.${k}` : k); return; }
  fail(`${path} debe ser numérico`);
}

export function parseScoringRules(json: string): ScoringRules {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { fail("JSON no parseable"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("se espera un objeto");
  checkNumbers(raw, "");
  const r = raw as Partial<ScoringRules>;
  const d = DEFAULT_SCORING;
  return {
    completeness: { ...d.completeness, ...r.completeness },
    urgencia: { ...d.urgencia, ...r.urgencia },
    proximidad: [...(r.proximidad ?? d.proximidad)].sort((a, b) => a.maxDias - b.maxDias),
    grupo: { ...d.grupo, ...r.grupo },
    tipo: { ...d.tipo, ...r.tipo },
  };
}
