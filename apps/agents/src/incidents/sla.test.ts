import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, contact, conversation, incident, kpi_event, on_call } from "../db/schema.ts";
import type { OutboundMessage } from "../channels/types.ts";
import { seedProtocol } from "../protocols/seed.ts";
import { startProtocol, type RunnerDeps } from "./runner.ts";
import { closeStale, escalateOverdue, runDueTimers } from "./sla.ts";
import { saveIncident } from "./store.ts";
import { eq } from "drizzle-orm";

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

async function seed(estado: "clasificando" | "conversacional" = "clasificando", n = 1) {
  if (n === 1) sent = [];
  const [c] = await db.insert(contact).values({ email: n === 1 ? "ana@example.com" : `viajero${n}@example.com` }).returning();
  const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "sim" }).returning();
  const [b] = await db.insert(booking).values({
    codigo: `BX-${1000 + n}`, viajero_nombre: "Ana García", destino: "Lisboa",
    inicio: new Date("2026-11-07T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
    servicios: [{ tipo: "traslado", proveedor: "TransLis", email: "ops@translis.test", lugar: "Aeropuerto LIS" }],
  }).returning();
  if (n === 1) await db.insert(on_call).values({ nombre: "Guardia", email: "guardia@bextia.test" });
  const [inc] = await db.insert(incident).values({ booking_id: b.id, conversation_id: conv.id, contact_id: c.id, estado }).returning();
  return { inc, t: { channel: "sim" as const, to: { email: c.email! }, conversationId: conv.id } };
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

  // Falla UNA vez, justo al guardar el avance del protocolo (después de reclamar la espera).
  const failingOnce = (now: Date): RunnerDeps => {
    let armed = true;
    return {
      ...deps(now),
      db: new Proxy(db, {
        get: (o, p, r) => {
          if (p !== "update") return Reflect.get(o, p, r);
          return (tbl: never) => {
            const b = (o.update as (t: never) => { set: (v: Record<string, unknown>) => unknown })(tbl);
            return { set: (v: Record<string, unknown>) => {
              if (armed && "protocolo_estado" in v) { armed = false; throw new RangeError("boom ana@example.com"); }
              return b.set(v);
            } };
          };
        },
      }),
    } as RunnerDeps;
  };

  it("si el avance falla tras reclamar, la espera vuelve y el siguiente barrido la procesa", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed();
    await startProtocol(deps(t0), inc, "traslado_no_presentado", t);
    const wait = (await row()).proximo_paso_at;
    const later = new Date("2026-11-08T10:21:00Z");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runDueTimers(failingOnce(later))).toEqual({ ran: 0, failed: 1 });
    expect(spy.mock.calls.flat().join(" ")).not.toContain("ana@example.com");
    spy.mockRestore();
    expect((await row()).proximo_paso_at).toEqual(wait);
    expect(await runDueTimers(deps(later))).toEqual({ ran: 1, failed: 0 });
    expect((await row()).estado).toBe("seguimiento");
  });

  it("un fallo en una incidencia no corta el resto", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    for (const n of [1, 2]) {
      const { inc, t } = await seed("clasificando", n);
      await startProtocol(deps(t0), inc, "traslado_no_presentado", t);
    }
    const later = new Date("2026-11-08T10:21:00Z");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runDueTimers(failingOnce(later))).toEqual({ ran: 1, failed: 1 });
    spy.mockRestore();
    expect(await runDueTimers(deps(later))).toEqual({ ran: 1, failed: 0 });
    expect((await db.select().from(incident)).map((i) => i.estado)).toEqual(["seguimiento", "seguimiento"]);
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

// BD cuyo primer select (la lectura del barrido) ejecuta `hook` justo después de devolver las filas:
// simula que otro proceso cambia la incidencia entre la lectura y el guardado del escalado.
function raceAfterFirstSelect(hook: () => Promise<void>): Db {
  let armed = true;
  const wrap = (b: object): object => new Proxy(b, {
    get(t, p) {
      if (p === "then") {
        const then = (t as PromiseLike<unknown>).then.bind(t);
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          then(async (rows) => { await hook(); return rows; }).then(res, rej);
      }
      const v = Reflect.get(t, p, t);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        const r = (v as (...x: unknown[]) => unknown).apply(t, a);
        return r && typeof r === "object" && "then" in r ? wrap(r) : r;
      };
    },
  });
  return new Proxy(db, {
    get(o, p, r) {
      if (p !== "select") { const v = Reflect.get(o, p, r); return typeof v === "function" ? v.bind(o) : v; }
      return (...a: unknown[]) => {
        const b = (o.select as (...x: unknown[]) => object)(...a);
        if (!armed) return b;
        armed = false;
        return wrap(b);
      };
    },
  });
}

describe("escalateOverdue: solo escala lo que sigue pendiente (I2)", () => {
  it("una consulta con sla_vence vencido que pasó a conversacional no se escala", async () => {
    const { inc } = await seed();
    await db.update(incident).set({ sla_vence: new Date("2026-11-08T10:00:00Z"), urgencia: "baja" });
    const [cur] = await db.select().from(incident).where(eq(incident.id, inc.id));
    const raced = raceAfterFirstSelect(async () => { await saveIncident(db, cur, { estado: "conversacional" }, t0); });
    expect(await escalateOverdue({ ...deps(t0), db: raced })).toBe(0);
    expect(await row()).toMatchObject({ estado: "conversacional", requiere_humano: false, sla_vence: null });
    expect(sent).toHaveLength(0);
  });

  it("una fila que el runner pasó a seguimiento entre la lectura y el guardado no se escala", async () => {
    const { inc } = await seed();
    await db.update(incident).set({ estado: "protocolo", sla_vence: new Date("2026-11-08T10:00:00Z"), urgencia: "alta" });
    const [cur] = await db.select().from(incident).where(eq(incident.id, inc.id));
    const raced = raceAfterFirstSelect(async () => { await saveIncident(db, cur, { estado: "seguimiento" }, t0); });
    expect(await escalateOverdue({ ...deps(t0), db: raced })).toBe(0);
    expect(await row()).toMatchObject({ estado: "seguimiento", requiere_humano: false });
    expect(sent).toHaveLength(0);
  });

  it("M9: el escalado por SLA de un protocolo lo marca terminado", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed();
    await startProtocol(deps(t0), inc, "traslado_no_presentado", t);
    await db.update(incident).set({ sla_vence: new Date("2026-11-08T10:00:00Z"), urgencia: "alta" });
    expect(await escalateOverdue(deps(new Date("2026-11-08T10:06:00Z")))).toBe(1);
    expect(await row()).toMatchObject({ estado: "escalado" });
    expect((await row()).protocolo_estado?.terminado).toBe(true);
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
