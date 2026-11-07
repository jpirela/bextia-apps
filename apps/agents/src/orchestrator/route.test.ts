import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import { booking, business_hours, contact } from "../db/schema.ts";
import type { Db } from "../db/index.ts";
import { route } from "./route.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(business_hours).values({
    mercado: "ES", zona_horaria: "Europe/Madrid", horario: { mon: [["09:00", "18:00"]] }, festivos: [],
  });
});
afterEach(async () => close());

const mondayNight = new Date("2026-11-09T22:00:00Z"); // 23:00 Madrid
const mondayMorning = new Date("2026-11-09T09:00:00Z"); // 10:00 Madrid

async function newContact(telefono: string) {
  const [c] = await db.insert(contact).values({ telefono }).returning();
  return c;
}

describe("route", () => {
  it("sin viaje activo va a leads y detecta fuera de horario", async () => {
    const c = await newContact("+34600000001");
    const d = await route(db, { contact: c, at: mondayNight, defaultMarket: "ES" });
    expect(d).toEqual({ agent: "leads", market: "ES", withinHours: false, bookingId: null });
  });

  it("dentro de horario lo marca", async () => {
    const c = await newContact("+34600000001");
    expect((await route(db, { contact: c, at: mondayMorning, defaultMarket: "ES" })).withinHours).toBe(true);
  });

  it("con viaje activo va a incidents", async () => {
    const c = await newContact("+34600000002");
    const [b] = await db.insert(booking).values({
      codigo: "BX-1", viajero_nombre: "Eva", viajero_telefono: "+34600000002", destino: "Tokio",
      inicio: new Date("2026-11-05T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
    }).returning();
    const d = await route(db, { contact: c, at: mondayNight, defaultMarket: "ES" });
    expect(d.agent).toBe("incidents");
    expect(d.bookingId).toBe(b.id);
  });

  it("con dos viajes activos elige el de inicio más reciente de forma determinista", async () => {
    const c = await newContact("+34600000004");
    await db.insert(booking).values({
      codigo: "BX-3", viajero_nombre: "Ivo", viajero_telefono: "+34600000004", destino: "Lisboa",
      inicio: new Date("2026-11-05T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
    });
    const [recent] = await db.insert(booking).values({
      codigo: "BX-4", viajero_nombre: "Ivo", viajero_telefono: "+34600000004", destino: "Oporto",
      inicio: new Date("2026-11-07T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
    }).returning();
    const d = await route(db, { contact: c, at: mondayNight, defaultMarket: "ES" });
    expect(d.bookingId).toBe(recent.id);
  });

  it("una reserva ya terminada no cuenta como viaje activo", async () => {
    const c = await newContact("+34600000003");
    await db.insert(booking).values({
      codigo: "BX-2", viajero_nombre: "Leo", viajero_telefono: "+34600000003", destino: "Roma",
      inicio: new Date("2026-10-01T00:00:00Z"), fin: new Date("2026-10-10T00:00:00Z"),
    });
    expect((await route(db, { contact: c, at: mondayNight, defaultMarket: "ES" })).agent).toBe("leads");
  });

  it("mercado sin horario configurado se trata como fuera de horario", async () => {
    const c = await newContact("+5215500000000");
    const d = await route(db, { contact: c, at: mondayMorning, defaultMarket: "MX" });
    expect(d.withinHours).toBe(false);
  });
});
