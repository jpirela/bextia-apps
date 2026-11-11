import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, contact, conversation, incident, incident_action, kpi_event, on_call } from "../db/schema.ts";
import type { OutboundMessage } from "../channels/types.ts";
import { seedProtocol } from "../protocols/seed.ts";
import * as engine from "../protocols/engine.ts";
import { escalateWithNotice, isAuthorizableAmount, runProtocol, startProtocol, type RunnerDeps } from "./runner.ts";
import { ESCALATED_REPLY } from "./prompts.ts";
import { saveIncident, type IncidentRow } from "./store.ts";

vi.mock("../protocols/engine.ts", async (importOriginal) => {
  const m = await importOriginal<typeof import("../protocols/engine.ts")>();
  return { ...m, advance: vi.fn(m.advance) };
});

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => { vi.mocked(engine.advance).mockClear(); await close(); });

const now = new Date("2026-11-08T10:05:00Z");
let sent: OutboundMessage[];

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  sent = [];
  return {
    db, now: () => now, mailer: null, providerChannels: { whatsapp: false, email: false, sim: true },
    send: async (m) => { sent.push(m); return { externalId: "" }; },
    ...over,
  };
}

async function seed(servicios = [{ tipo: "traslado" as const, proveedor: "TransLis", email: "ops@translis.test", inicio: "2026-11-08T10:00:00Z", lugar: "Aeropuerto LIS", referencia: "TL-77" }]) {
  const [c] = await db.insert(contact).values({ email: "ana@example.com" }).returning();
  const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "sim" }).returning();
  const [b] = await db.insert(booking).values({
    codigo: "BX-1001", viajero_nombre: "Ana García", destino: "Lisboa", viajero_email: "ana@example.com",
    inicio: new Date("2026-11-07T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"), servicios,
  }).returning();
  await db.insert(on_call).values({ nombre: "Guardia", email: "guardia@bextia.test" });
  const [inc] = await db.insert(incident).values({ booking_id: b.id, conversation_id: conv.id, contact_id: c.id, estado: "clasificando" }).returning();
  const t = { channel: "sim" as const, to: { email: "ana@example.com" }, conversationId: conv.id };
  return { inc, t };
}

const traveler = () => sent.filter((m) => m.to.email === "ana@example.com").map((m) => m.text);
const provider = () => sent.filter((m) => m.to.email === "ops@translis.test").map((m) => m.text);
const reload = async (id: string): Promise<IncidentRow> => (await db.select().from(incident)).find((i) => i.id === id)!;
const actionTypes = async () => (await db.select().from(incident_action)).map((a) => a.tipo);
const kpiTypes = async () => (await db.select().from(kpi_event)).map((k) => k.tipo);

describe("runner", () => {
  it("startProtocol: contacta al proveedor, avisa al viajero y programa la espera", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed();
    const row = await startProtocol(deps(), inc, "traslado_no_presentado", t);
    expect(row).toMatchObject({ estado: "protocolo", proveedor_contacto: "ops@translis.test", proximo_paso_at: new Date("2026-11-08T10:20:00Z") });
    expect(row.protocolo_estado).toMatchObject({ paso: "esperar", terminado: false });
    expect(sent.find((m) => m.to.email === "ops@translis.test")?.text).toContain("TL-77");
    expect(traveler()).toEqual(["Ana, ya estamos contactando a TransLis. Te escribimos en un máximo de 15 minutos."]);
    expect(await actionTypes()).toEqual(["decision", "mensaje_proveedor", "mensaje_viajero", "espera"]);
  });

  it("vencimiento: autoriza el taxi por el tope, confirma, pide feedback y pasa a seguimiento", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed();
    const started = await startProtocol(deps(), inc, "traslado_no_presentado", t);
    const row = await runProtocol(deps({ now: () => new Date("2026-11-08T10:21:00Z") }), started, { tipo: "vencimiento" });
    expect(traveler()).toEqual([
      "TransLis no confirmó a tiempo. Toma un taxi oficial hasta tu hotel: te reembolsamos hasta 40.00 EUR. Guarda el recibo.",
      "Cuando estés en el hotel, cuéntanos en una frase cómo fue todo.",
    ]);
    expect(row).toMatchObject({ estado: "seguimiento", proximo_paso_at: new Date("2026-11-09T10:21:00Z") });
    const auth = (await db.select().from(incident_action)).find((a) => a.tipo === "autorizacion");
    expect(auth).toMatchObject({ monto: "40.00", detalle: { concepto: "taxi", moneda: "EUR" } });
    const kpis = await kpiTypes();
    expect(kpis).toContain("gasto_autorizado");
    expect(kpis).toContain("incidencia_resuelta");
  });

  it("respuesta del proveedor con ETA: confirma al viajero, sin autorizar gasto", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed();
    const started = await startProtocol(deps(), inc, "traslado_no_presentado", t);
    const row = await runProtocol(deps(), started, { tipo: "respuesta_proveedor", eta_min: 12 }, t);
    expect(traveler()).toEqual([
      "Buenas noticias: TransLis llega en unos 12 minutos a Aeropuerto LIS.",
      "Cuando estés en el hotel, cuéntanos en una frase cómo fue todo.",
    ]);
    expect(row.estado).toBe("seguimiento");
    expect(await actionTypes()).not.toContain("autorizacion");
  });

  it("sin protocolo activo → escala con aviso al viajero", async () => {
    const { inc, t } = await seed();
    const row = await startProtocol(deps(), inc, "traslado_no_presentado", t);
    expect(row).toMatchObject({ estado: "escalado", requiere_humano: true });
    expect(traveler()).toEqual([ESCALATED_REPLY]);
  });

  it("proveedor sin canal disponible → escala y no avisa la espera", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed();
    const row = await startProtocol(deps({ providerChannels: { whatsapp: false, email: false } }), inc, "traslado_no_presentado", t);
    expect(row.estado).toBe("escalado");
    expect(row.proximo_paso_at).toBeNull();
    expect(traveler()).toEqual([ESCALATED_REPLY]);
    expect((await db.select().from(incident_action)).find((a) => a.tipo === "escalado")?.detalle).toMatchObject({ motivo: "proveedor_sin_canal" });
    expect((await reload(inc.id)).protocolo_estado).toMatchObject({ terminado: true });
  });

  it("envío al proveedor fallido → escala, sin aviso de espera ni temporizador", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed();
    const d = deps();
    d.send = async (m) => {
      if (m.to.email === "ops@translis.test") throw new Error("smtp caído");
      sent.push(m);
      return { externalId: "" };
    };
    const row = await startProtocol(d, inc, "traslado_no_presentado", t);
    expect(row).toMatchObject({ estado: "escalado", proximo_paso_at: null });
    expect(traveler()).toEqual([ESCALATED_REPLY]);
    expect((await db.select().from(incident_action)).find((a) => a.tipo === "escalado")?.detalle).toMatchObject({ motivo: "proveedor_envio_fallido" });
  });

  it("servicio no verificable → el motor escala", async () => {
    await seedProtocol(db, { tope: 40, moneda: "EUR" });
    const { inc, t } = await seed([]);
    const row = await startProtocol(deps(), inc, "traslado_no_presentado", t);
    expect(row.estado).toBe("escalado");
    expect(traveler()).toEqual([ESCALATED_REPLY]);
    expect((await reload(inc.id)).protocolo_estado).toMatchObject({ terminado: true });
  });

  describe("temporizador (M3): solo dispara con espera_hasta <= now", () => {
    it("vencimiento antes de tiempo → no hace nada", async () => {
      await seedProtocol(db, { tope: 40, moneda: "EUR" });
      const { inc, t } = await seed();
      const started = await startProtocol(deps(), inc, "traslado_no_presentado", t);
      const row = await runProtocol(deps({ now: () => new Date("2026-11-08T10:19:59.999Z") }), started, { tipo: "vencimiento" }, t);
      expect(sent).toEqual([]);
      expect(row).toMatchObject({ estado: "protocolo", proximo_paso_at: new Date("2026-11-08T10:20:00Z") });
      expect(row.protocolo_estado).toMatchObject({ paso: "esperar", terminado: false });
      expect(await actionTypes()).not.toContain("autorizacion");
    });

    it("vencimiento exactamente en espera_hasta → dispara", async () => {
      await seedProtocol(db, { tope: 40, moneda: "EUR" });
      const { inc, t } = await seed();
      const started = await startProtocol(deps(), inc, "traslado_no_presentado", t);
      const row = await runProtocol(deps({ now: () => new Date("2026-11-08T10:20:00Z") }), started, { tipo: "vencimiento" }, t);
      expect(row.estado).toBe("seguimiento");
      expect(await actionTypes()).toContain("autorizacion");
    });
  });

  describe("guardarraíl de monto (segunda barrera)", () => {
    it("isAuthorizableAmount: > 0 y ≤ tope", () => {
      expect(isAuthorizableAmount(0, 40)).toBe(false);
      expect(isAuthorizableAmount(-1, 40)).toBe(false);
      expect(isAuthorizableAmount(Number.NaN, 40)).toBe(false);
      expect(isAuthorizableAmount(Number.POSITIVE_INFINITY, 40)).toBe(false);
      expect(isAuthorizableAmount(40.01, 40)).toBe(false);
      expect(isAuthorizableAmount(40, 40)).toBe(true);
      expect(isAuthorizableAmount(0.01, 40)).toBe(true);
      expect(isAuthorizableAmount(10, Number.NaN)).toBe(false);
    });

    async function runWithAmount(monto: number) {
      await seedProtocol(db, { tope: 40, moneda: "EUR" });
      const { inc, t } = await seed();
      const started = await startProtocol(deps(), inc, "traslado_no_presentado", t);
      vi.mocked(engine.advance).mockImplementationOnce((_def, state) => ({
        state: { ...state!, paso: "feedback", espera_hasta: null, autorizado: monto, terminado: true },
        actions: [
          { tipo: "autorizar", monto, concepto: "taxi" },
          { tipo: "enviar_viajero", texto: "taxi autorizado" },
          { tipo: "feedback", texto: "¿qué tal?" },
        ],
      }));
      const row = await runProtocol(deps({ now: () => new Date("2026-11-08T10:21:00Z") }), started, { tipo: "vencimiento" }, t);
      return { row, inc };
    }

    for (const monto of [0, -5, Number.NaN, 40.01]) {
      it(`monto ${monto} → escala sin autorizar`, async () => {
        const { row, inc } = await runWithAmount(monto);
        expect(row.estado).toBe("escalado");
        expect(traveler()).toEqual([ESCALATED_REPLY]);
        expect(await actionTypes()).not.toContain("autorizacion");
        expect(await kpiTypes()).not.toContain("gasto_autorizado");
        expect((await db.select().from(incident_action)).find((a) => a.tipo === "escalado")?.detalle).toMatchObject({ motivo: "monto_fuera_de_tope" });
        expect((await reload(inc.id)).protocolo_estado).toMatchObject({ autorizado: null, terminado: true });
      });
    }

    it("monto exactamente igual al tope → autoriza", async () => {
      const { row } = await runWithAmount(40);
      expect(row.estado).toBe("seguimiento");
      expect((await db.select().from(incident_action)).find((a) => a.tipo === "autorizacion")?.monto).toBe("40.00");
      expect(traveler()).toEqual(["taxi autorizado", "¿qué tal?"]);
    });
  });

  describe("carreras (StaleIncidentError)", () => {
    it("dos vencimientos simultáneos → una sola autorización y un solo juego de mensajes", async () => {
      await seedProtocol(db, { tope: 40, moneda: "EUR" });
      const { inc, t } = await seed();
      const started = await startProtocol(deps(), inc, "traslado_no_presentado", t);
      const d = deps({ now: () => new Date("2026-11-08T10:21:00Z") });
      const rows = await Promise.all([
        runProtocol(d, started, { tipo: "vencimiento" }, t),
        runProtocol(d, started, { tipo: "vencimiento" }, t),
      ]);
      expect(rows.map((r) => r.estado)).toEqual(["seguimiento", "seguimiento"]);
      expect((await actionTypes()).filter((x) => x === "autorizacion")).toHaveLength(1);
      expect((await kpiTypes()).filter((x) => x === "gasto_autorizado")).toHaveLength(1);
      expect(traveler()).toHaveLength(2);
    });

    it("dos startProtocol simultáneos → un solo contacto al proveedor", async () => {
      await seedProtocol(db, { tope: 40, moneda: "EUR" });
      const { inc, t } = await seed();
      const d = deps();
      const rows = await Promise.all([
        startProtocol(d, inc, "traslado_no_presentado", t),
        startProtocol(d, inc, "traslado_no_presentado", t),
      ]);
      expect(rows.map((r) => r.estado)).toEqual(["protocolo", "protocolo"]);
      expect(provider()).toHaveLength(1);
      expect(traveler()).toHaveLength(1);
    });

    it("fila en memoria desfasada (otro proceso ya avanzó) → relee y no repite efectos", async () => {
      await seedProtocol(db, { tope: 40, moneda: "EUR" });
      const { inc, t } = await seed();
      const started = await startProtocol(deps(), inc, "traslado_no_presentado", t);
      await saveIncident(db, started, { estado: "cerrado" }, now);
      const row = await runProtocol(deps({ now: () => new Date("2026-11-08T10:21:00Z") }), started, { tipo: "vencimiento" }, t);
      expect(row.estado).toBe("cerrado");
      expect(sent).toEqual([]);
      expect(await actionTypes()).not.toContain("autorizacion");
    });
  });

  describe("escalateWithNotice", () => {
    it("avisa al viajero solo si esta llamada escaló (sin avisos dobles)", async () => {
      const { inc, t } = await seed();
      const d = deps();
      const rows = await Promise.all([
        escalateWithNotice(d, inc, "prueba", t),
        escalateWithNotice(d, inc, "prueba", t),
      ]);
      expect(rows.map((r) => r.estado)).toEqual(["escalado", "escalado"]);
      expect(traveler()).toEqual([ESCALATED_REPLY]);
      // Fila en memoria desfasada: ya escalada en BD.
      const again = await escalateWithNotice(d, inc, "prueba", t);
      expect(again.estado).toBe("escalado");
      expect(traveler()).toEqual([ESCALATED_REPLY]);
      expect((await actionTypes()).filter((x) => x === "escalado")).toHaveLength(1);
    });

    it("sin destino del viajero → escala sin aviso", async () => {
      const { inc } = await seed();
      const row = await escalateWithNotice(deps(), inc, "prueba", null);
      expect(row.estado).toBe("escalado");
      expect(sent).toEqual([]);
    });
  });
});
