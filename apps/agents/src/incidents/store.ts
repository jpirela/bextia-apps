import { and, eq, isNotNull, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import {
  incident, incident_action, kpi_event,
  type IncidentActionType, type IncidentState, type IncidentUrgency,
} from "../db/schema.ts";
import type { Channel } from "../channels/types.ts";

export type IncidentRow = typeof incident.$inferSelect;
export type IncidentPatch = Partial<Omit<typeof incident.$inferInsert, "id" | "booking_id" | "created_at" | "cerrado_at">>;

export const INACTIVITY_MS = 24 * 60 * 60_000;

export const TRANSITIONS: Record<IncidentState, IncidentState[]> = {
  identificando: ["bienvenida", "clasificando", "escalado", "cerrado"],
  bienvenida: ["clasificando", "escalado", "cerrado"],
  clasificando: ["protocolo", "conversacional", "escalado", "cerrado"],
  protocolo: ["seguimiento", "escalado", "cerrado"],
  conversacional: ["clasificando", "protocolo", "escalado", "cerrado"],
  escalado: ["cerrado"],
  seguimiento: ["cerrado", "escalado"],
  cerrado: [],
};

export function canTransition(from: IncidentState, to: IncidentState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  override name = "InvalidTransitionError";
  constructor(from: IncidentState, to: IncidentState) { super(`${from} → ${to}`); }
}

export class StaleIncidentError extends Error {
  override name = "StaleIncidentError";
  constructor() { super("incidencia modificada por otro proceso o inexistente"); }
}

export const SLA_MINUTES: Record<IncidentUrgency, number> = { critica: 10, alta: 30, media: 60, baja: 240 };

export async function findOrCreateIncident(
  db: Db,
  input: { bookingId: string; conversationId: string; contactId: string; now: Date },
): Promise<IncidentRow> {
  const open = () => db.select().from(incident)
    .where(and(eq(incident.conversation_id, input.conversationId), ne(incident.estado, "cerrado"))).limit(1);
  const [found] = await open();
  if (found) return found;
  // El índice único parcial (Task 1) resuelve la carrera entre dos mensajes simultáneos.
  await db.insert(incident).values({
    booking_id: input.bookingId, conversation_id: input.conversationId, contact_id: input.contactId,
    proximo_paso_at: new Date(input.now.getTime() + INACTIVITY_MS),
  }).onConflictDoNothing();
  const [row] = await open();
  if (!row) throw new Error("incidencia no creada");
  return row;
}

export interface SaveOptions {
  // Condiciona además sobre protocolo_estado = current.protocolo_estado (igualdad jsonb): cerrojo
  // optimista del runner para que dos avances del mismo paso no ejecuten efectos dos veces.
  guardProtocolState?: boolean;
}

export async function saveIncident(
  db: Db, current: IncidentRow, patch: IncidentPatch, now = new Date(), opts: SaveOptions = {},
): Promise<IncidentRow> {
  const next = patch.estado ?? current.estado;
  if (!canTransition(current.estado, next)) throw new InvalidTransitionError(current.estado, next);
  const set: IncidentPatch & { cerrado_at?: Date } = { ...patch };
  if (next === "cerrado" && current.estado !== "cerrado") set.cerrado_at = now;
  const conds: SQL[] = [eq(incident.id, current.id), eq(incident.estado, current.estado)];
  if (opts.guardProtocolState) {
    conds.push(current.protocolo_estado === null
      ? isNull(incident.protocolo_estado)
      : sql`${incident.protocolo_estado} = ${JSON.stringify(current.protocolo_estado)}::jsonb`);
  }
  if (patch.urgencia && !current.sla_vence && !patch.sla_vence) {
    set.sla_vence = new Date(now.getTime() + SLA_MINUTES[patch.urgencia] * 60_000);
    conds.push(isNull(incident.sla_vence));
  }
  const [row] = await db.update(incident).set(set).where(and(...conds)).returning();
  if (!row) throw new StaleIncidentError();
  return row;
}

export async function logAction(
  db: Db, incidentId: string, tipo: IncidentActionType, detalle: Record<string, unknown> = {}, monto?: number,
): Promise<void> {
  if (monto !== undefined && (!Number.isFinite(monto) || monto < 0)) throw new RangeError("monto inválido");
  await db.insert(incident_action).values({
    incident_id: incidentId, tipo, detalle, monto: monto === undefined ? null : monto.toFixed(2),
  });
}

export async function recordKpi(
  db: Db, tipo: string, e: { ref_id: string; valor?: number; canal?: Channel; datos?: Record<string, unknown> },
): Promise<void> {
  await db.insert(kpi_event).values({
    tipo, agente: "incidents", ref_id: e.ref_id, valor: e.valor ?? null, canal: e.canal ?? null, datos: e.datos ?? {},
  });
}

// Devuelve la espera reclamada si el avance falló antes de cambiar el estado del protocolo:
// solo actúa si nadie más la reprogramó ni avanzó el protocolo (mismo estado jsonb).
export async function restoreWait(db: Db, inc: IncidentRow): Promise<boolean> {
  if (!inc.proximo_paso_at) return false;
  const rows = await db.update(incident).set({ proximo_paso_at: inc.proximo_paso_at }).where(and(
    eq(incident.id, inc.id), eq(incident.estado, "protocolo"), isNull(incident.proximo_paso_at),
    inc.protocolo_estado === null
      ? isNull(incident.protocolo_estado)
      : sql`${incident.protocolo_estado} = ${JSON.stringify(inc.protocolo_estado)}::jsonb`,
  )).returning({ id: incident.id });
  return rows.length === 1;
}

// Reclama la espera de un protocolo (respuesta del proveedor o vencimiento): solo un llamador gana.
export async function claimWait(db: Db, id: string, dueBy?: Date): Promise<boolean> {
  const conds: SQL[] = [eq(incident.id, id), eq(incident.estado, "protocolo"), isNotNull(incident.proximo_paso_at)];
  if (dueBy) conds.push(lte(incident.proximo_paso_at, dueBy));
  const rows = await db.update(incident).set({ proximo_paso_at: null }).where(and(...conds)).returning({ id: incident.id });
  return rows.length === 1;
}
