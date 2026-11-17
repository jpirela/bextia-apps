import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, contact } from "../db/schema.ts";
import { createApp } from "../server/app.ts";
import { createRateLimiter } from "../server/rate-limit.ts";
import { createTestAuth } from "../auth/test-keys.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const HEADER = "codigo,viajero_nombre,viajero_telefono,viajero_email,destino,inicio,fin,traslado_proveedor,traslado_telefono,traslado_email,traslado_inicio,traslado_lugar,traslado_referencia";
const ROW_OK = "BX-1,Ana Ruiz,+34600000001,ANA@example.com,Lisboa,2026-11-08T08:00:00Z,2026-11-12T08:00:00Z,Taxis Lis,+351910000000,,2026-11-08T09:30:00Z,Aeropuerto T1,TR-9";
const ROW_BAD = "BX-2,Beto,600123,,Roma,2026-11-10T08:00:00Z,2026-11-09T08:00:00Z,,,,,,";

async function setup() {
  const t = await createTestAuth();
  const pipeline = async () => ({ status: "routed" as const, conversationId: "c" });
  const app = createApp({
    auth: t.config, corsOrigins: [], channels: {}, pipeline,
    ipLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), api: { db, pipeline },
    importToken: "imp-tok", importEmailSecret: "mail-sec",
  });
  return { t, app };
}

describe("importación de reservas", () => {
  it("CSV del panel: crea, reporta errores por fila y hace upsert", async () => {
    const { t, app } = await setup();
    const admin = await t.tokenFor("admin");
    const send = (csv: string) => app.request("/api/import/bookings", { method: "POST", body: csv, headers: { authorization: `Bearer ${admin}`, "content-type": "text/csv" } });
    const r1 = await (await send([HEADER, ROW_OK, ROW_BAD].join("\n"))).json();
    expect(r1.creadas).toBe(1);
    expect(r1.errores.map((e: { fila: number; field: string }) => [e.fila, e.field])).toEqual(expect.arrayContaining([[3, "viajero_telefono"], [3, "fin"]]));
    const [b] = await db.select().from(booking).where(eq(booking.codigo, "BX-1"));
    // BookingService del schema real: telefono/email planos (no `contacto` anidado).
    expect(b.servicios).toEqual([{ tipo: "traslado", proveedor: "Taxis Lis", telefono: "+351910000000", inicio: "2026-11-08T09:30:00.000Z", lugar: "Aeropuerto T1", referencia: "TR-9" }]);
    const [c] = await db.select().from(contact).where(eq(contact.id, b.contact_id!));
    expect(c.email).toBe("ana@example.com");
    const r2 = await (await send([HEADER, ROW_OK.replace("Lisboa", "Oporto")].join("\n"))).json();
    expect(r2).toMatchObject({ creadas: 0, actualizadas: 1 });
    expect((await db.select().from(contact)).length).toBe(1);
  });

  it("solo admin; cabecera incompleta o CSV roto → 400", async () => {
    const { t, app } = await setup();
    const admin = await t.tokenFor("admin");
    const op = await t.tokenFor("operador");
    const send = (csv: string, tk = admin) => app.request("/api/import/bookings", { method: "POST", body: csv, headers: { authorization: `Bearer ${tk}`, "content-type": "text/csv" } });
    expect((await send(`${HEADER}\n${ROW_OK}`, op)).status).toBe(403);
    expect((await send("codigo,destino\nX,Roma")).status).toBe(400);
    expect((await send(`${HEADER}\n"abierta`)).status).toBe(400);
  });

  it("API externa con IMPORT_TOKEN (JSON) y email con secreto", async () => {
    const { app } = await setup();
    const row = Object.fromEntries(HEADER.split(",").map((k, i) => [k, ROW_OK.split(",")[i]]));
    expect((await app.request("/import/bookings", { method: "POST", body: JSON.stringify({ rows: [row] }), headers: { "content-type": "application/json" } })).status).toBe(401);
    const ok = await app.request("/import/bookings", { method: "POST", body: JSON.stringify({ rows: [row] }), headers: { authorization: "Bearer imp-tok", "content-type": "application/json" } });
    expect(await ok.json()).toMatchObject({ creadas: 1 });
    const csv = Buffer.from([HEADER, ROW_OK.replace("BX-1", "BX-3")].join("\n")).toString("base64");
    const mail = (secret: string) => app.request("/import/email", {
      method: "POST", headers: { "x-import-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ attachments: [{ filename: "reservas.csv", contentType: "text/csv", contentBase64: csv }, { filename: "foto.jpg", contentType: "image/jpeg", contentBase64: "AAAA" }] }),
    });
    expect((await mail("otro")).status).toBe(401);
    expect(await (await mail("mail-sec")).json()).toMatchObject({ creadas: 1 });
  });

  it("sin IMPORT_TOKEN configurado, la ruta externa no existe", async () => {
    const t = await createTestAuth();
    const pipeline = async () => ({ status: "routed" as const, conversationId: "c" });
    const app = createApp({ auth: t.config, corsOrigins: [], channels: {}, pipeline, ipLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), api: { db, pipeline } });
    expect((await app.request("/import/bookings", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/import/email", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
