import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { booking, incident, protocol, type BookingService } from "../db/schema.ts";
import type { Mailer } from "../notify/mailer.ts";
import { advance } from "../protocols/engine.ts";
import { parseProtocol } from "../protocols/parse.ts";
import type { ProtocolContext, ProtocolDef, ProtocolEvent } from "../protocols/types.ts";
import { escalateIncidentResult, type EscalationExtra } from "./escalate.ts";
import { ESCALATED_REPLY } from "./prompts.ts";
import { providerTarget, type ProviderChannels, type ProviderTarget } from "./provider.ts";
import { sendProvider, sendTraveler, targetFromIncident, type AgentIo, type TravelerTarget } from "./reply.ts";
import {
  INACTIVITY_MS, logAction, recordKpi, saveIncident, StaleIncidentError,
  type IncidentPatch, type IncidentRow, type SaveOptions,
} from "./store.ts";

type State = IncidentRow["protocolo_estado"];

// Igualdad semántica del estado del protocolo (lo mismo que compara el jsonb en la BD).
function sameState(a: State, b: State): boolean {
  if (a === null || b === null) return a === b;
  return a.paso === b.paso && a.espera_hasta === b.espera_hasta && a.eta_min === b.eta_min
    && a.autorizado === b.autorizado && a.terminado === b.terminado;
}

// Al escalar por un fallo del runner, el protocolo queda terminado en la misma escritura del escalado.
const markTerminated: EscalationExtra = (c) =>
  c.protocolo_estado ? { protocolo_estado: { ...c.protocolo_estado, terminado: true } } : {};

export interface RunnerDeps extends AgentIo { mailer: Mailer | null; backofficeUrl?: string | null; providerChannels: ProviderChannels }
export interface LoadedProtocol { id: string; def: ProtocolDef; tope: number; moneda: string }

const isClosed = (inc: IncidentRow) => inc.estado === "escalado" || inc.estado === "cerrado";

// Guardarraíl (spec §5), segunda barrera tras el motor: el monto debe ser > 0 y ≤ tope.
export function isAuthorizableAmount(monto: number, tope: number): boolean {
  return Number.isFinite(monto) && Number.isFinite(tope) && monto > 0 && monto <= tope;
}

function toLoaded(row: typeof protocol.$inferSelect): LoadedProtocol | null {
  try {
    return { id: row.id, def: parseProtocol(row.definicion), tope: Number(row.tope_autorizado ?? 0), moneda: row.moneda };
  } catch (err) {
    console.error("incidencias: protocolo inválido en BD", (err as Error).name);
    return null;
  }
}

export async function loadProtocol(db: Db, codigo: string): Promise<LoadedProtocol | null> {
  const [row] = await db.select().from(protocol).where(and(eq(protocol.codigo, codigo), eq(protocol.activo, true))).limit(1);
  return row ? toLoaded(row) : null;
}

// La incidencia queda atada a la versión con la que arrancó (protocol_id), aunque luego se siembre otra.
async function protocolById(db: Db, id: string): Promise<LoadedProtocol | null> {
  const [row] = await db.select().from(protocol).where(eq(protocol.id, id)).limit(1);
  return row ? toLoaded(row) : null;
}

// Guarda el cambio de estado; si otro proceso ganó la carrera, relee la fila y devuelve null
// para que quien llama se detenga sin repetir efectos (mensajes, contacto, autorización).
async function commit(
  db: Db, inc: IncidentRow, patch: IncidentPatch, now: Date, opts: SaveOptions = {},
): Promise<{ row: IncidentRow; won: boolean }> {
  try {
    return { row: await saveIncident(db, inc, patch, now, opts), won: true };
  } catch (err) {
    if (!(err instanceof StaleIncidentError)) throw err;
    console.warn("incidencias: carrera perdida en el runner", err.name);
    const [fresh] = await db.select().from(incident).where(eq(incident.id, inc.id));
    if (!fresh) throw err;
    return { row: fresh, won: false };
  }
}

// Primero escala (transición atómica) y solo si esta llamada ganó avisa al viajero: sin avisos dobles.
export async function escalateWithNotice(
  deps: RunnerDeps, inc: IncidentRow, motivo: string, t: TravelerTarget | null, extra?: EscalationExtra,
): Promise<IncidentRow> {
  const { row, escalated } = await escalateIncidentResult(deps, inc, motivo, extra);
  if (escalated && t) await sendTraveler(deps, t, row.id, ESCALATED_REPLY);
  return row;
}

export async function startProtocol(deps: RunnerDeps, inc: IncidentRow, codigo: string, t: TravelerTarget): Promise<IncidentRow> {
  if (isClosed(inc) || inc.protocolo_estado) return inc;
  const p = await loadProtocol(deps.db, codigo);
  if (!p) return escalateWithNotice(deps, inc, "sin_protocolo", t);
  // La transición a "protocolo" es el cerrojo: si dos arranques compiten, solo uno sigue.
  const { row, won } = await commit(deps.db, inc, { estado: "protocolo", protocol_id: p.id }, deps.now());
  if (!won) return row;
  return runProtocol(deps, row, { tipo: "inicio" }, t);
}

export async function runProtocol(deps: RunnerDeps, inc: IncidentRow, event: ProtocolEvent, target?: TravelerTarget | null): Promise<IncidentRow> {
  if (isClosed(inc)) return inc;
  const { db } = deps;
  const now = deps.now();
  const t = target ?? (await targetFromIncident(db, inc));
  const p = inc.protocol_id ? await protocolById(db, inc.protocol_id) : null;
  if (!p) return escalateWithNotice(deps, inc, "sin_protocolo", t);

  // Un vencimiento solo dispara si la espera ya venció (espera_hasta <= now).
  const prev = inc.protocolo_estado;
  if (event.tipo === "vencimiento" && prev?.espera_hasta && new Date(prev.espera_hasta).getTime() > now.getTime()) return inc;

  const [b] = await db.select().from(booking).where(eq(booking.id, inc.booking_id));
  if (!b) return escalateWithNotice(deps, inc, "sin_reserva", t);
  const servicio = ((b.servicios ?? []) as BookingService[]).find((s) => s.tipo === "traslado") ?? null;
  const ctx: ProtocolContext = {
    now, tope: p.tope, moneda: p.moneda,
    booking: { codigo: b.codigo, viajero_nombre: b.viajero_nombre }, servicio,
  };
  const r = advance(p.def, prev, event, ctx);
  if (r.actions.length === 0) return inc;
  // El cerrojo del commit es protocolo_estado previo: todo avance con efectos debe cambiarlo.
  // Si no cambia (definición cíclica en el mismo milisegundo, p. ej.), no hay cerrojo: se escala sin efectos.
  if (sameState(r.state, prev)) return escalateWithNotice(deps, inc, "estado_sin_cambio", t);

  // 1) Planificar: validar todo lo que puede abortar (canal del proveedor, monto) antes de cualquier efecto.
  const patch: IncidentPatch = { protocolo_estado: r.state };
  let pt: ProviderTarget | null = null;
  let abort: { at: number; motivo: string } | null = null;
  for (const [i, a] of r.actions.entries()) {
    if (a.tipo === "enviar_proveedor") {
      pt = providerTarget(servicio, deps.providerChannels);
      if (!pt) { abort = { at: i, motivo: "proveedor_sin_canal" }; break; }
      patch.proveedor_contacto = pt.contacto;
    } else if (a.tipo === "autorizar" && !isAuthorizableAmount(a.monto, p.tope)) {
      abort = { at: i, motivo: "monto_fuera_de_tope" }; break;
    } else if (a.tipo === "programar") {
      patch.proximo_paso_at = a.at;
    } else if (a.tipo === "feedback") {
      patch.estado = "seguimiento";
      patch.proximo_paso_at = new Date(now.getTime() + INACTIVITY_MS);
    }
  }
  const toSave: IncidentPatch = abort && r.state
    ? { protocolo_estado: { ...r.state, terminado: true, autorizado: prev?.autorizado ?? null } }
    : patch;

  // 2) Persistir la transición ANTES de los efectos, condicionada a estado Y protocolo_estado previos:
  //    de dos avances del mismo paso solo uno gana; el perdedor se detiene aquí sin efectos.
  const { row, won } = await commit(db, inc, toSave, now, { guardProtocolState: true });
  if (!won) return row;
  let cur = row;

  // 3) Efectos, en el orden del motor (solo los anteriores al aborto, si lo hay).
  const actions = abort ? r.actions.slice(0, abort.at) : r.actions;
  for (const a of actions) {
    switch (a.tipo) {
      case "decision":
        await logAction(db, cur.id, "decision", a.detalle);
        break;
      case "enviar_viajero":
        if (t) await sendTraveler(deps, t, cur.id, a.texto);
        break;
      case "enviar_proveedor":
        if (!(await sendProvider(deps, pt!, cur.id, a.texto))) return escalateWithNotice(deps, cur, "proveedor_envio_fallido", t, markTerminated);
        break;
      case "programar":
        await logAction(db, cur.id, "espera", { hasta: a.at.toISOString() });
        break;
      case "autorizar":
        await logAction(db, cur.id, "autorizacion", { concepto: a.concepto, moneda: p.moneda }, a.monto);
        await recordKpi(db, "gasto_autorizado", { ref_id: cur.id, valor: a.monto, datos: { concepto: a.concepto, moneda: p.moneda } });
        break;
      case "escalar":
        return escalateWithNotice(deps, cur, a.motivo, t);
      case "feedback":
        if (t) await sendTraveler(deps, t, cur.id, a.texto);
        await logAction(db, cur.id, "resultado", { eta_min: r.state?.eta_min ?? null, autorizado: r.state?.autorizado ?? null });
        await recordKpi(db, "incidencia_resuelta", { ref_id: cur.id, valor: (now.getTime() - cur.created_at.getTime()) / 60_000 });
        break;
    }
  }
  if (abort) cur = await escalateWithNotice(deps, cur, abort.motivo, t);
  return cur;
}
