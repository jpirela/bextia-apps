import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, contact, conversation, incident, incident_action, kpi_event } from "../db/schema.ts";
import {
  canTransition, claimWait, findOrCreateIncident, InvalidTransitionError, logAction, recordKpi, saveIncident, StaleIncidentError,
} from "./store.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const now = new Date("2026-11-08T10:00:00Z");
async function seed() {
  const [c] = await db.insert(contact).values({ telefono: "+34600000001" }).returning();
  const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "sim" }).returning();
  const [b] = await db.insert(booking).values({
    codigo: "BX-1001", viajero_nombre: "Ana García", destino: "Lisboa",
    inicio: new Date("2026-11-07T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
  }).returning();
  return { input: { bookingId: b.id, conversationId: conv.id, contactId: c.id, now } };
}

describe("transiciones", () => {
  it("permite el mismo estado y las del mapa; prohíbe salir de cerrado", () => {
    expect(canTransition("protocolo", "protocolo")).toBe(true);
    expect(canTransition("identificando", "bienvenida")).toBe(true);
    expect(canTransition("protocolo", "seguimiento")).toBe(true);
    expect(canTransition("escalado", "protocolo")).toBe(false);
    expect(canTransition("cerrado", "identificando")).toBe(false);
  });
});

describe("store de incidencias", () => {
  it("findOrCreate es idempotente y abre otra tras cerrar", async () => {
    const { input } = await seed();
    const a = await findOrCreateIncident(db, input);
    const b = await findOrCreateIncident(db, input);
    expect(b.id).toBe(a.id);
    expect(a.estado).toBe("identificando");
    expect(a.proximo_paso_at).toEqual(new Date("2026-11-09T10:00:00Z"));
    await saveIncident(db, a, { estado: "cerrado" }, now);
    expect((await findOrCreateIncident(db, input)).id).not.toBe(a.id);
  });

  it("saveIncident valida, fija SLA al recibir urgencia y cerrado_at al cerrar", async () => {
    const { input } = await seed();
    const a = await findOrCreateIncident(db, input);
    await expect(saveIncident(db, a, { estado: "seguimiento" }, now)).rejects.toBeInstanceOf(InvalidTransitionError);
    const b = await saveIncident(db, a, { estado: "clasificando", urgencia: "alta" }, now);
    expect(b.sla_vence).toEqual(new Date("2026-11-08T10:30:00Z"));
    const c = await saveIncident(db, b, { urgencia: "critica" }, new Date("2026-11-08T10:10:00Z"));
    expect(c.sla_vence).toEqual(new Date("2026-11-08T10:30:00Z")); // el SLA no se reinicia
    const d = await saveIncident(db, c, { estado: "cerrado" }, now);
    expect(d.cerrado_at).toEqual(now);
  });

  it("logAction guarda el monto con 2 decimales; recordKpi usa agente incidents", async () => {
    const { input } = await seed();
    const a = await findOrCreateIncident(db, input);
    await logAction(db, a.id, "autorizacion", { concepto: "taxi" }, 40);
    await logAction(db, a.id, "decision");
    const rows = await db.select().from(incident_action);
    expect(rows.map((r) => [r.tipo, r.monto])).toEqual([["autorizacion", "40.00"], ["decision", null]]);
    await recordKpi(db, "incidencia_clasificada", { ref_id: a.id, datos: { tipologia: "consulta" } });
    expect((await db.select().from(kpi_event))[0]).toMatchObject({ tipo: "incidencia_clasificada", agente: "incidents", ref_id: a.id });
  });

  it("claimWait reclama una sola vez y respeta dueBy", async () => {
    const { input } = await seed();
    const a = await findOrCreateIncident(db, input);
    await db.update(incident).set({ estado: "protocolo", proximo_paso_at: new Date("2026-11-08T10:15:00Z") }).where(eq(incident.id, a.id));
    expect(await claimWait(db, a.id, new Date("2026-11-08T10:14:00Z"))).toBe(false);
    expect(await claimWait(db, a.id, new Date("2026-11-08T10:15:00Z"))).toBe(true);
    expect(await claimWait(db, a.id)).toBe(false);
  });

  it("claimWait devuelve false fuera de protocolo y solo uno gana en concurrencia", async () => {
    const { input } = await seed();
    const a = await findOrCreateIncident(db, input);
    await db.update(incident).set({ proximo_paso_at: new Date("2026-11-08T10:15:00Z") }).where(eq(incident.id, a.id));
    expect(await claimWait(db, a.id)).toBe(false); // estado identificando
    await db.update(incident).set({ estado: "protocolo" }).where(eq(incident.id, a.id));
    const r = await Promise.all([claimWait(db, a.id), claimWait(db, a.id)]);
    expect(r.filter(Boolean)).toHaveLength(1);
  });

  it("saveIncident es atómico: de dos escritores con la misma foto solo uno gana", async () => {
    const { input } = await seed();
    const a = await findOrCreateIncident(db, input);
    const res = await Promise.allSettled([
      saveIncident(db, a, { estado: "cerrado" }, now),
      saveIncident(db, a, { estado: "escalado" }, now),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(StaleIncidentError);
    const [row] = await db.select().from(incident).where(eq(incident.id, a.id));
    const winner = (res.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<typeof a>).value;
    expect(row.estado).toBe(winner.estado);
  });

  it("no reabre un cerrado y rechaza montos inválidos", async () => {
    const { input } = await seed();
    const a = await findOrCreateIncident(db, input);
    await saveIncident(db, a, { estado: "cerrado" }, now);
    await expect(saveIncident(db, a, { estado: "bienvenida" }, now)).rejects.toBeInstanceOf(StaleIncidentError);
    await expect(logAction(db, a.id, "decision", {}, -1)).rejects.toBeInstanceOf(RangeError);
    await expect(logAction(db, a.id, "decision", {}, Number.NaN)).rejects.toBeInstanceOf(RangeError);
  });
});
