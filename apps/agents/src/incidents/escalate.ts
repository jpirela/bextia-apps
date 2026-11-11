import { asc, eq, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { booking, incident, on_call } from "../db/schema.ts";
import type { Mailer } from "../notify/mailer.ts";
import { logAction, recordKpi, saveIncident, StaleIncidentError, type IncidentPatch, type IncidentRow } from "./store.ts";

export interface EscalationDeps { db: Db; mailer: Mailer | null; backofficeUrl?: string | null; now?: () => Date }

const MAX_STALE_RETRIES = 3;

// Campos adicionales que se guardan en la misma escritura atómica del escalado. Se calculan sobre la
// fila vigente en cada intento (tras releerla si hubo carrera). No pueden pisar los campos del escalado.
export type EscalationExtra = (current: IncidentRow) => IncidentPatch;

// Al escalar, el protocolo (si lo hay) queda terminado en la misma escritura del escalado.
export const markTerminated: EscalationExtra = (c) =>
  c.protocolo_estado ? { protocolo_estado: { ...c.protocolo_estado, terminado: true } } : {};

// Condición para escalar, evaluada sobre la fila vigente en cada intento (también tras releerla si hubo
// carrera): `check` en memoria y `where` en el mismo UPDATE. Si deja de cumplirse, no se escala.
export interface EscalationGuard { check: (current: IncidentRow) => boolean; where: SQL }

export async function pickOnCall(db: Db): Promise<typeof on_call.$inferSelect | null> {
  const [g] = await db.select().from(on_call).where(eq(on_call.activo, true))
    .orderBy(asc(on_call.prioridad), asc(on_call.created_at)).limit(1);
  return g ?? null;
}

// Si otro proceso cambió el estado entre la lectura y el guardado (StaleIncidentError), se relee y
// se reintenta: la guardia debe enterarse aunque se pierda la carrera. Si el ganador ya escaló o
// cerró la incidencia, no hay nada más que hacer (quien escaló ya avisó).
async function saveEscalated(
  db: Db, inc: IncidentRow, guardEmail: string | null, now: Date, extra?: EscalationExtra, onlyIf?: EscalationGuard,
): Promise<{ row: IncidentRow; won: boolean }> {
  let current = inc;
  for (let attempt = 0; ; attempt++) {
    if (onlyIf && !onlyIf.check(current)) return { row: current, won: false };
    try {
      const row = await saveIncident(db, current, {
        ...extra?.(current),
        estado: "escalado", requiere_humano: true, escalado_a: guardEmail, proximo_paso_at: null,
      }, now, { where: onlyIf?.where });
      return { row, won: true };
    } catch (err) {
      if (!(err instanceof StaleIncidentError) || attempt >= MAX_STALE_RETRIES) throw err;
      const [fresh] = await db.select().from(incident).where(eq(incident.id, current.id));
      if (!fresh) throw err;
      if (fresh.estado === "escalado" || fresh.estado === "cerrado") return { row: fresh, won: false };
      current = fresh;
    }
  }
}

export async function escalateIncident(deps: EscalationDeps, inc: IncidentRow, motivo: string): Promise<IncidentRow> {
  return (await escalateIncidentResult(deps, inc, motivo)).row;
}

// Igual que escalateIncident, pero indica si esta llamada fue la que escaló (la ganadora).
// Permite a quien llama avisar al viajero una sola vez.
export async function escalateIncidentResult(
  deps: EscalationDeps, inc: IncidentRow, motivo: string, extra?: EscalationExtra, onlyIf?: EscalationGuard,
): Promise<{ row: IncidentRow; escalated: boolean }> {
  if (inc.estado === "escalado" || inc.estado === "cerrado") return { row: inc, escalated: false };
  const now = deps.now?.() ?? new Date();
  const guard = await pickOnCall(deps.db);
  const { row, won } = await saveEscalated(deps.db, inc, guard?.email ?? null, now, extra, onlyIf);
  if (!won) return { row, escalated: false };
  await logAction(deps.db, inc.id, "escalado", { motivo, guardia: guard?.email ?? null });
  await recordKpi(deps.db, "incidencia_escalada", { ref_id: inc.id, datos: { motivo } });
  await notifyGuard(deps, row, motivo, guard);
  return { row, escalated: true };
}

// Re-aviso a la guardia sobre una incidencia que YA está escalada (p. ej. llega una emergencia
// después de un escalado por llm_fallido): deja acción y KPI con el motivo nuevo y vuelve a avisar.
export async function renotifyOnCall(deps: EscalationDeps, row: IncidentRow, motivo: string): Promise<void> {
  const guard = await pickOnCall(deps.db);
  await logAction(deps.db, row.id, "escalado", { motivo, guardia: guard?.email ?? null, reaviso: true });
  await recordKpi(deps.db, "incidencia_escalada", { ref_id: row.id, datos: { motivo, reaviso: true } });
  await notifyGuard(deps, row, motivo, guard);
}

async function notifyGuard(
  deps: EscalationDeps, row: IncidentRow, motivo: string, guard: typeof on_call.$inferSelect | null,
): Promise<void> {
  const failed = (m: "sin_guardia" | "sin_smtp" | "envio") => recordKpi(deps.db, "aviso_guardia_fallido", { ref_id: row.id, datos: { motivo: m } });
  if (!guard) { await failed("sin_guardia"); return; }
  if (!deps.mailer) { await failed("sin_smtp"); return; }
  const [b] = await deps.db.select({ codigo: booking.codigo }).from(booking).where(eq(booking.id, row.booking_id));
  const link = deps.backofficeUrl ? `${deps.backofficeUrl.replace(/\/+$/, "")}/incidencias/${row.id}` : `Incidencia ${row.id}`;
  try {
    await deps.mailer.send({
      to: guard.email,
      subject: `[BEXTIA] Incidencia escalada (${motivo})`,
      text: [
        `Reserva: ${b?.codigo ?? "-"}`,
        `Urgencia: ${row.urgencia ?? "-"}`,
        `Tipología: ${row.tipologia ?? "-"}`,
        `Resumen: ${row.resumen_ia ?? "-"}`,
        `Motivo: ${motivo}`,
        "",
        link,
      ].join("\n"),
    });
  } catch (err) {
    console.error("escalado: aviso a guardia fallido", (err as Error).name);
    await failed("envio");
  }
}
