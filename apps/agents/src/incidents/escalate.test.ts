import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, contact, conversation, incident_action, kpi_event, on_call } from "../db/schema.ts";
import type { Mail } from "../notify/mailer.ts";
import { escalateIncident, pickOnCall } from "./escalate.ts";
import { findOrCreateIncident, saveIncident } from "./store.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const now = new Date("2026-11-08T10:00:00Z");
async function seedIncident() {
  const [c] = await db.insert(contact).values({ telefono: "+34600000001" }).returning();
  const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "sim" }).returning();
  const [b] = await db.insert(booking).values({
    codigo: "BX-1001", viajero_nombre: "Ana García", destino: "Lisboa",
    inicio: new Date("2026-11-07T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
  }).returning();
  const inc = await findOrCreateIncident(db, { bookingId: b.id, conversationId: conv.id, contactId: c.id, now });
  return saveIncident(db, inc, { estado: "clasificando", tipologia: "otra", urgencia: "alta", resumen_ia: "Caso no contemplado." }, now);
}
const mailerOk = () => {
  const sent: Mail[] = [];
  return { sent, mailer: { async send(m: Mail) { sent.push(m); return { messageId: "m" }; } } };
};

describe("escalado", () => {
  it("elige la guardia activa de menor prioridad", async () => {
    await db.insert(on_call).values([
      { nombre: "B", email: "b@bextia.test", prioridad: 2 },
      { nombre: "X", email: "x@bextia.test", prioridad: 0, activo: false },
      { nombre: "A", email: "a@bextia.test", prioridad: 1 },
    ]);
    expect((await pickOnCall(db))?.email).toBe("a@bextia.test");
  });

  it("marca la incidencia, registra acción y KPI, y avisa por email (idempotente)", async () => {
    await db.insert(on_call).values({ nombre: "A", email: "a@bextia.test" });
    const inc = await seedIncident();
    const { sent, mailer } = mailerOk();
    const deps = { db, mailer, backofficeUrl: "https://bo.test/", now: () => now };
    const out = await escalateIncident(deps, inc, "no_contemplada");
    expect(out).toMatchObject({ estado: "escalado", requiere_humano: true, escalado_a: "a@bextia.test", proximo_paso_at: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "a@bextia.test", subject: "[BEXTIA] Incidencia escalada (no_contemplada)" });
    expect(sent[0].text).toContain("BX-1001");
    expect(sent[0].text).toContain(`https://bo.test/incidencias/${inc.id}`);
    expect((await db.select().from(incident_action)).map((a) => a.tipo)).toEqual(["escalado"]);
    expect((await db.select().from(kpi_event)).map((k) => k.tipo)).toEqual(["incidencia_escalada"]);
    await escalateIncident(deps, out, "no_contemplada");
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["sin guardia", false, mailerOk().mailer, "sin_guardia"],
    ["sin SMTP", true, null, "sin_smtp"],
    ["envío fallido", true, { async send(): Promise<{ messageId: string }> { throw new Error("smtp"); } }, "envio"],
  ] as const)("%s → escala igual y registra aviso_guardia_fallido", async (_n, withGuard, mailer, motivo) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    if (withGuard) await db.insert(on_call).values({ nombre: "A", email: "a@bextia.test" });
    const out = await escalateIncident({ db, mailer, now: () => now }, await seedIncident(), "emocional");
    expect(out.estado).toBe("escalado");
    const k = (await db.select().from(kpi_event)).find((e) => e.tipo === "aviso_guardia_fallido");
    expect(k?.datos).toEqual({ motivo });
  });

  it("pierde una carrera de estado (lectura obsoleta) → relee, escala y avisa igual", async () => {
    await db.insert(on_call).values({ nombre: "A", email: "a@bextia.test" });
    const stale = await seedIncident(); // estado "clasificando"
    await saveIncident(db, stale, { estado: "protocolo" }, now); // otro proceso lo mueve
    const { sent, mailer } = mailerOk();
    const out = await escalateIncident({ db, mailer, now: () => now }, stale, "no_contemplada");
    expect(out).toMatchObject({ estado: "escalado", requiere_humano: true, escalado_a: "a@bextia.test" });
    expect(sent).toHaveLength(1);
    expect((await db.select().from(incident_action)).map((a) => a.tipo)).toEqual(["escalado"]);
  });

  it("si otro proceso ya escaló mientras tanto → no duplica acción, KPI ni email", async () => {
    await db.insert(on_call).values({ nombre: "A", email: "a@bextia.test" });
    const stale = await seedIncident();
    const { sent, mailer } = mailerOk();
    const deps = { db, mailer, now: () => now };
    await escalateIncident(deps, stale, "primero");
    const out = await escalateIncident(deps, stale, "segundo"); // `stale` sigue en "clasificando"
    expect(out.estado).toBe("escalado");
    expect(sent).toHaveLength(1);
    expect(await db.select().from(incident_action)).toHaveLength(1);
    expect(await db.select().from(kpi_event)).toHaveLength(1);
  });
});
