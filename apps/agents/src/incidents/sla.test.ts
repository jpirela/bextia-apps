import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, contact, conversation, incident, kpi_event, on_call } from "../db/schema.ts";
import type { OutboundMessage } from "../channels/types.ts";
import { seedProtocol } from "../protocols/seed.ts";
import { startProtocol, type RunnerDeps } from "./runner.ts";
import { closeStale, escalateOverdue, runDueTimers } from "./sla.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const t0 = new Date("2026-11-08T10:05:00Z");
let sent: OutboundMessage[];
const deps = (now: Date): RunnerDeps => ({
  db, now: () => now, mailer: null, providerChannels: { whatsapp: false, email: false, sim: true },
  send: async (m) => { sent.push(m); return { externalId: "" }; },
});

async function seed(estado: "clasificando" | "conversacional" = "clasificando") {
  sent = [];
  const [c] = await db.insert(contact).values({ email: "ana@example.com" }).returning();
  const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "sim" }).returning();
  const [b] = await db.insert(booking).values({
    codigo: "BX-1001", viajero_nombre: "Ana García", destino: "Lisboa",
    inicio: new Date("2026-11-07T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
    servicios: [{ tipo: "traslado", proveedor: "TransLis", email: "ops@translis.test", lugar: "Aeropuerto LIS" }],
  }).returning();
  await db.insert(on_call).values({ nombre: "Guardia", email: "guardia@bextia.test" });
  const [inc] = await db.insert(incident).values({ booking_id: b.id, conversation_id: conv.id, contact_id: c.id, estado }).returning();
  return { inc, t: { channel: "sim" as const, to: { email: "ana@example.com" }, conversationId: conv.id } };
}

const row = async () => (await db.select().from(incident))[0];

describe("runDueTimers", () => {
  it("no hace nada antes del vencimiento; después autoriza el taxi una sola vez", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed();
    await startProtocol(deps(t0), inc, "traslado_no_presentado", t);
    expect(await runDueTimers(deps(new Date("2026-11-08T10:10:00Z")))).toEqual({ ran: 0, failed: 0 });
    const later = new Date("2026-11-08T10:21:00Z");
    expect(await runDueTimers(deps(later))).toEqual({ ran: 1, failed: 0 });
    expect(await runDueTimers(deps(later))).toEqual({ ran: 0, failed: 0 });
    expect(sent.at(-2)?.text).toContain("40.00 EUR");
    expect((await row()).estado).toBe("seguimiento");
  });

  it("dos barridos simultáneos no duplican efectos", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed();
    await startProtocol(deps(t0), inc, "traslado_no_presentado", t);
    const later = new Date("2026-11-08T10:21:00Z");
    const [a, b] = await Promise.all([runDueTimers(deps(later)), runDueTimers(deps(later))]);
    expect(a.ran + b.ran).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    expect((await db.select().from(kpi_event)).filter((k) => k.tipo === "gasto_autorizado")).toHaveLength(1);
  });

  it("un fallo en una incidencia no corta el resto y no registra PII", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed();
    await startProtocol(deps(t0), inc, "traslado_no_presentado", t);
    const later = new Date("2026-11-08T10:21:00Z");
    const bad = {
      ...deps(later),
      db: new Proxy(db, { get: (o, p, r) => (p === "update" ? () => { throw new RangeError("boom ana@example.com"); } : Reflect.get(o, p, r)) }),
    } as RunnerDeps;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runDueTimers(bad)).toEqual({ ran: 0, failed: 1 });
    expect(spy.mock.calls.flat().join(" ")).not.toContain("ana@example.com");
    spy.mockRestore();
  });
});

describe("escalateOverdue", () => {
  it("escala lo que venció su SLA sin humano asignado", async () => {
    await seed();
    await db.update(incident).set({ sla_vence: new Date("2026-11-08T10:00:00Z"), urgencia: "alta" });
    expect(await escalateOverdue(deps(t0))).toBe(1);
    expect(await row()).toMatchObject({ estado: "escalado", requiere_humano: true });
    expect((await db.select().from(kpi_event)).map((k) => k.tipo)).toContain("sla_incumplido");
    expect(await escalateOverdue(deps(t0))).toBe(0);
  });

  it("dos barridos simultáneos registran el KPI y avisan una sola vez", async () => {
    await seed();
    await db.update(incident).set({ sla_vence: new Date("2026-11-08T10:00:00Z"), urgencia: "alta" });
    await Promise.all([escalateOverdue(deps(t0)), escalateOverdue(deps(t0))]);
    expect((await db.select().from(kpi_event)).filter((k) => k.tipo === "sla_incumplido")).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});

describe("closeStale", () => {
  it("cierra conversaciones inactivas", async () => {
    await seed("conversacional");
    await db.update(incident).set({ proximo_paso_at: new Date("2026-11-08T10:00:00Z") });
    expect(await closeStale(db, t0)).toBe(1);
    expect(await row()).toMatchObject({ estado: "cerrado", proximo_paso_at: null });
    expect((await row()).cerrado_at).toEqual(t0);
    expect((await db.select().from(kpi_event)).map((k) => k.tipo)).toEqual(["incidencia_cerrada_inactividad"]);
  });
});
