import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./test-db.ts";
import type { Db } from "./index.ts";
import { booking, contact, conversation, incident, on_call, protocol, web_otp } from "./schema.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

async function seed() {
  const [c] = await db.insert(contact).values({ telefono: "+34600000001" }).returning();
  const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "sim" }).returning();
  const [b] = await db.insert(booking).values({
    codigo: "BX-1001", viajero_nombre: "Ana García", destino: "Lisboa",
    inicio: new Date("2026-11-08T00:00:00Z"), fin: new Date("2026-11-15T00:00:00Z"),
    servicios: [{ tipo: "traslado", proveedor: "TransLis", telefono: "+351910000000", inicio: "2026-11-08T10:00:00Z", lugar: "Aeropuerto LIS" }],
  }).returning();
  return { c, conv, b };
}

describe("esquema agente 2", () => {
  it("una sola incidencia no cerrada por conversación", async () => {
    const { c, conv, b } = await seed();
    await db.insert(incident).values({ booking_id: b.id, conversation_id: conv.id, contact_id: c.id });
    await expect(db.insert(incident).values({ booking_id: b.id, conversation_id: conv.id, contact_id: c.id })).rejects.toThrow();
    await db.update(incident).set({ estado: "cerrado" });
    await db.insert(incident).values({ booking_id: b.id, conversation_id: conv.id, contact_id: c.id });
    expect(await db.select().from(incident)).toHaveLength(2);
  });

  it("defaults de columnas nuevas", async () => {
    const { conv, b } = await seed();
    const [i] = await db.insert(incident).values({ booking_id: b.id, conversation_id: conv.id }).returning();
    expect(i).toMatchObject({ estado: "identificando", requiere_humano: false, intentos_identificacion: 0, protocolo_estado: null });
    const [p] = await db.insert(protocol).values({ codigo: "x", nombre: "X", version: 1, definicion: {} }).returning();
    expect(p.moneda).toBe("EUR");
    const [g] = await db.insert(on_call).values({ nombre: "Guardia", email: "guardia@bextia.test" }).returning();
    expect(g).toMatchObject({ prioridad: 1, activo: true });
    const [o] = await db.insert(web_otp).values({ destino: "a@b.test", codigo_hash: "h", expira_at: new Date() }).returning();
    expect(o).toMatchObject({ intentos: 0, usado_at: null });
    expect(b.bienvenida_at).toBeNull();
  });
});
