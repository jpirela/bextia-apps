import { and, desc, eq, gte, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { booking, business_hours, incident, incident_action, type AgentName } from "../db/schema.ts";
import type { ContactRow } from "../gateway/ingest.ts";
import { InvalidBusinessHoursError, isWithinBusinessHours, ruleFromRow } from "./business-hours.ts";

export interface RouteDecision {
  agent: AgentName;
  market: string;
  withinHours: boolean;
  bookingId: string | null;
  verified: boolean; // el contacto coincide con la reserva (si no, el Agente 2 pide el apellido)
  providerIncidentId: string | null; // el remitente es el proveedor contactado por un protocolo
  // El remitente es proveedor, pero no de una única incidencia en protocolo: varias (ambiguo) o
  // ninguna en protocolo (fuera_de_protocolo). Nunca va a leads ni avanza un protocolo.
  providerOther?: { motivo: "ambiguo" | "fuera_de_protocolo"; incidentIds: string[] };
}

export const BOOKING_CODE = /\b[A-Z]{2,4}-\d{4,8}\b/;

const active = (at: Date) => and(lte(booking.inicio, at), gte(booking.fin, at));

async function findActiveBookingId(db: Db, c: ContactRow, at: Date): Promise<string | null> {
  const ids: SQL[] = [];
  if (c.telefono) ids.push(eq(booking.viajero_telefono, c.telefono));
  if (c.email) ids.push(eq(booking.viajero_email, c.email));
  if (c.id) ids.push(eq(booking.contact_id, c.id));
  if (ids.length === 0) return null;
  const [row] = await db.select({ id: booking.id }).from(booking)
    .where(and(or(...ids), active(at))).orderBy(desc(booking.inicio)).limit(1);
  return row?.id ?? null;
}

async function openIncident(db: Db, conversationId: string) {
  const [row] = await db.select({ booking_id: incident.booking_id, estado: incident.estado }).from(incident)
    .where(and(eq(incident.conversation_id, conversationId), ne(incident.estado, "cerrado"))).limit(1);
  return row ?? null;
}

// Ventana en la que un remitente sigue reconociéndose como proveedor de una incidencia no cerrada.
export const PROVIDER_WINDOW_MS = 7 * 24 * 60 * 60_000;

type ProviderMatch =
  | { kind: "one"; id: string; booking_id: string }
  | { kind: "other"; booking_id: string; motivo: "ambiguo" | "fuera_de_protocolo"; incidentIds: string[] };

// El remitente es proveedor si coincide (sin distinguir mayúsculas) con el proveedor_contacto de una
// incidencia no cerrada con actividad en los últimos 7 días. La tabla no tiene updated_at: la última
// actividad es la última acción registrada o, si no hay, la creación.
// Varias en protocolo: no se puede saber a cuál responde → ninguna avanza (P37).
async function providerIncident(db: Db, c: ContactRow, at: Date): Promise<ProviderMatch | null> {
  const addrs = [c.telefono, c.email].filter((x): x is string => !!x).map((x) => x.trim().toLowerCase());
  if (addrs.length === 0) return null;
  const since = new Date(at.getTime() - PROVIDER_WINDOW_MS);
  const lastActivity = sql`coalesce((select max(${incident_action.created_at}) from ${incident_action} where ${incident_action.incident_id} = ${incident.id}), ${incident.created_at})`;
  const rows = await db.select({ id: incident.id, booking_id: incident.booking_id, estado: incident.estado }).from(incident)
    .where(and(
      ne(incident.estado, "cerrado"),
      or(...addrs.map((a) => sql`lower(${incident.proveedor_contacto}) = ${a}`)),
      sql`${lastActivity} >= ${since.toISOString()}::timestamptz`,
    ))
    .orderBy(desc(incident.created_at));
  if (rows.length === 0) return null;
  const inProtocol = rows.filter((r) => r.estado === "protocolo");
  if (inProtocol.length === 1) return { kind: "one", id: inProtocol[0].id, booking_id: inProtocol[0].booking_id };
  if (inProtocol.length > 1) {
    return { kind: "other", booking_id: inProtocol[0].booking_id, motivo: "ambiguo", incidentIds: inProtocol.map((r) => r.id) };
  }
  return { kind: "other", booking_id: rows[0].booking_id, motivo: "fuera_de_protocolo", incidentIds: rows.map((r) => r.id) };
}

async function bookingByCode(db: Db, text: string, at: Date): Promise<string | null> {
  const code = text.toUpperCase().match(BOOKING_CODE)?.[0];
  if (!code) return null;
  const [row] = await db.select({ id: booking.id }).from(booking).where(and(eq(booking.codigo, code), active(at))).limit(1);
  return row?.id ?? null;
}

export async function route(
  db: Db,
  input: { contact: ContactRow; at: Date; defaultMarket: string; text?: string; conversationId?: string },
): Promise<RouteDecision> {
  const market = input.contact.mercado ?? input.defaultMarket;
  const [bh] = await db.select().from(business_hours).where(eq(business_hours.mercado, market)).limit(1);
  // Sin horario configurado: se asume fuera de horario para que el agente atienda.
  let withinHours = false;
  if (bh) {
    try {
      withinHours = isWithinBusinessHours(ruleFromRow(bh), input.at);
    } catch (err) {
      if (!(err instanceof InvalidBusinessHoursError)) throw err;
      console.warn(`route: horario inválido para el mercado ${market}; se asume fuera de horario`);
    }
  }
  const base = { market, withinHours };
  const incidents = (bookingId: string, verified: boolean, providerIncidentId: string | null = null): RouteDecision =>
    ({ ...base, agent: "incidents", bookingId, verified, providerIncidentId });

  if (input.conversationId) {
    const open = await openIncident(db, input.conversationId);
    if (open) return incidents(open.booking_id, open.estado !== "identificando");
  }
  const prov = await providerIncident(db, input.contact, input.at);
  if (prov?.kind === "one") return incidents(prov.booking_id, false, prov.id);
  if (prov) {
    return { ...incidents(prov.booking_id, false), providerOther: { motivo: prov.motivo, incidentIds: prov.incidentIds } };
  }
  const own = await findActiveBookingId(db, input.contact, input.at);
  if (own) return incidents(own, true);
  if (input.text) {
    const byCode = await bookingByCode(db, input.text, input.at);
    if (byCode) return incidents(byCode, false);
  }
  return { ...base, agent: "leads", bookingId: null, verified: false, providerIncidentId: null };
}
