import { and, eq, gte, lte, or, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { booking, business_hours, type AgentName } from "../db/schema.ts";
import type { ContactRow } from "../gateway/ingest.ts";
import { isWithinBusinessHours, ruleFromRow } from "./business-hours.ts";

export interface RouteDecision {
  agent: AgentName;
  market: string;
  withinHours: boolean;
  bookingId: string | null;
}

async function findActiveBookingId(db: Db, c: ContactRow, at: Date): Promise<string | null> {
  const ids: SQL[] = [];
  if (c.telefono) ids.push(eq(booking.viajero_telefono, c.telefono));
  if (c.email) ids.push(eq(booking.viajero_email, c.email));
  if (c.id) ids.push(eq(booking.contact_id, c.id));
  const [row] = await db.select({ id: booking.id }).from(booking)
    .where(and(or(...ids), lte(booking.inicio, at), gte(booking.fin, at))).limit(1);
  return row?.id ?? null;
}

export async function route(
  db: Db,
  input: { contact: ContactRow; at: Date; defaultMarket: string },
): Promise<RouteDecision> {
  const market = input.contact.mercado ?? input.defaultMarket;
  const bookingId = await findActiveBookingId(db, input.contact, input.at);
  const [bh] = await db.select().from(business_hours).where(eq(business_hours.mercado, market)).limit(1);
  // Sin horario configurado: se asume fuera de horario para que el agente atienda.
  const withinHours = bh ? isWithinBusinessHours(ruleFromRow(bh), input.at) : false;
  return { agent: bookingId ? "incidents" : "leads", market, withinHours, bookingId };
}
