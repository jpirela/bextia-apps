import { and, desc, eq, gte, lte, ne, or, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { booking, business_hours, incident, type AgentName } from "../db/schema.ts";
import type { ContactRow } from "../gateway/ingest.ts";
import { InvalidBusinessHoursError, isWithinBusinessHours, ruleFromRow } from "./business-hours.ts";

export interface RouteDecision {
  agent: AgentName;
  market: string;
  withinHours: boolean;
  bookingId: string | null;
  verified: boolean; // el contacto coincide con la reserva (si no, el Agente 2 pide el apellido)
  providerIncidentId: string | null; // el remitente es el proveedor contactado por un protocolo
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

async function providerIncident(db: Db, c: ContactRow) {
  const addrs = [c.telefono, c.email].filter((x): x is string => !!x);
  if (addrs.length === 0) return null;
  const [row] = await db.select({ id: incident.id, booking_id: incident.booking_id }).from(incident)
    .where(and(eq(incident.estado, "protocolo"), or(...addrs.map((a) => eq(incident.proveedor_contacto, a)))))
    .orderBy(desc(incident.created_at)).limit(1);
  return row ?? null;
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
  const prov = await providerIncident(db, input.contact);
  if (prov) return incidents(prov.booking_id, false, prov.id);
  const own = await findActiveBookingId(db, input.contact, input.at);
  if (own) return incidents(own, true);
  if (input.text) {
    const byCode = await bookingByCode(db, input.text, input.at);
    if (byCode) return incidents(byCode, false);
  }
  return { ...base, agent: "leads", bookingId: null, verified: false, providerIncidentId: null };
}
