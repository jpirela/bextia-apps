import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { booking, contact, conversation, incident, incident_action, message } from "../db/schema.ts";
import { createApp } from "../server/app.ts";
import { createRateLimiter } from "../server/rate-limit.ts";
import { createTestAuth } from "../auth/test-keys.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const NOW = new Date("2026-11-08T12:00:00Z");

async function setup() {
  const t = await createTestAuth();
  const pipeline = async () => ({ status: "routed" as const, conversationId: "c" });
  const app = createApp({
    auth: t.config, corsOrigins: [], channels: {}, pipeline,
    ipLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), api: { db, pipeline, now: () => NOW },
  });
  const [c] = await db.insert(contact).values({ nombre: "Ana", telefono: "+34600000001" }).returning();
  const [b] = await db.insert(booking).values({
    codigo: "BX-1", contact_id: c.id, viajero_nombre: "Ana", destino: "Lisboa",
    inicio: new Date("2026-11-08T08:00:00Z"), fin: new Date("2026-11-12T08:00:00Z"),
  }).returning();
  const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "whatsapp", agente: "incidents" }).returning();
  await db.insert(message).values({ conversation_id: conv.id, canal: "whatsapp", direccion: "in", contenido: "No llegó el taxi", external_id: "wa-1" });
  const [i1] = await db.insert(incident).values({
    booking_id: b.id, conversation_id: conv.id, contact_id: c.id, tipologia: "traslado_no_presentado", urgencia: "alta",
    estado: "protocolo", requiere_humano: false, sla_vence: new Date("2026-11-08T12:30:00Z"),
  }).returning();
  const [i2] = await db.insert(incident).values({
    booking_id: b.id, contact_id: c.id, tipologia: "consulta", urgencia: "baja", estado: "escalado", requiere_humano: true,
  }).returning();
  await db.insert(incident_action).values({ incident_id: i1.id, tipo: "autorizacion", monto: "60.00", detalle: { concepto: "taxi" } });
  const call = async (method: string, path: string, token: string, body?: unknown) => app.request(path, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  return { t, call, i1, i2 };
}

describe("GET /api/incidents", () => {
  it("operador ve la bandeja: primero las que requieren humano", async () => {
    const { t, call, i1, i2 } = await setup();
    const res = await call("GET", "/api/incidents", await t.tokenFor("operador"));
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Array<{ id: string; reserva: { codigo: string } }> };
    expect(data.map((d) => d.id)).toEqual([i2.id, i1.id]);
    expect(data[0].reserva.codigo).toBe("BX-1");
  });
  it("filtra y valida; el comercial no entra", async () => {
    const { t, call } = await setup();
    const op = await t.tokenFor("operador");
    expect((await (await call("GET", "/api/incidents?tipologia=consulta", op)).json()).data).toHaveLength(1);
    expect((await (await call("GET", "/api/incidents?requiere_humano=true", op)).json()).data).toHaveLength(1);
    expect((await call("GET", "/api/incidents?urgencia=extrema", op)).status).toBe(400);
    expect((await call("GET", "/api/incidents", await t.tokenFor("comercial"))).status).toBe(403);
  });
  it("el detalle trae acciones y conversación", async () => {
    const { t, call, i1 } = await setup();
    const det = await (await call("GET", `/api/incidents/${i1.id}`, await t.tokenFor("admin"))).json();
    expect(det.acciones.map((a: { tipo: string }) => a.tipo)).toEqual(["autorizacion"]);
    expect(det.conversacion[0].contenido).toBe("No llegó el taxi");
  });
});

describe("PATCH /api/incidents/:id", () => {
  it("tomar: escala al email del operador y deja traza", async () => {
    const { t, call, i1 } = await setup();
    const res = await call("PATCH", `/api/incidents/${i1.id}`, await t.tokenFor("operador", "op@bextia.test"), { accion: "tomar", nota: "llamo al proveedor" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: "escalado", escalado_a: "op@bextia.test", requiere_humano: true });
    const acc = await db.select().from(incident_action).where(eq(incident_action.incident_id, i1.id));
    expect(acc.map((a) => a.tipo)).toContain("escalado");
  });

  it("reembolso: exige autorización y respeta el tope", async () => {
    const { t, call, i1, i2 } = await setup();
    const op = await t.tokenFor("operador");
    expect((await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "reembolso", monto: 75 })).status).toBe(400);
    expect((await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "reembolso", monto: 0 })).status).toBe(400);
    expect((await call("PATCH", `/api/incidents/${i2.id}`, op, { accion: "reembolso", monto: 10 })).status).toBe(409);
    expect((await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "reembolso", monto: 45.5 })).status).toBe(200);
    const [r] = await db.select().from(incident_action).where(eq(incident_action.tipo, "resultado"));
    expect(r).toMatchObject({ incident_id: i1.id, monto: "45.50" });
  });

  it("reembolso: el acumulado no supera lo autorizado", async () => {
    const { t, call, i1 } = await setup();
    const op = await t.tokenFor("operador");
    expect((await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "reembolso", monto: 40 })).status).toBe(200);
    expect((await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "reembolso", monto: 30 })).status).toBe(400);
    expect((await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "reembolso", monto: 0.004 })).status).toBe(400);
    const res = await db.select().from(incident_action).where(eq(incident_action.tipo, "resultado"));
    expect(res.map((r) => r.monto)).toEqual(["40.00"]);
  });

  it("tomar sin email en el token: 400", async () => {
    const { t, call, i1 } = await setup();
    expect((await call("PATCH", `/api/incidents/${i1.id}`, await t.tokenFor("operador", "x", { email: undefined }), { accion: "tomar" })).status).toBe(400);
  });

  it("cerrar: el segundo cierre da 409, una sola traza, y bloquea tomar después", async () => {
    const { t, call, i1 } = await setup();
    const op = await t.tokenFor("operador");
    const a = await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "cerrar" });
    expect(await a.json()).toMatchObject({ estado: "cerrado", cerrado_at: NOW.toISOString() });
    const b = await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "cerrar" });
    expect(b.status).toBe(409);
    expect(await b.json()).toEqual({ error: "closed" });
    const res = await db.select().from(incident_action).where(eq(incident_action.tipo, "resultado"));
    expect(res).toHaveLength(1);
    expect((await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "tomar" })).status).toBe(409);
  });

  it("valida la acción y la nota", async () => {
    const { t, call, i1 } = await setup();
    const op = await t.tokenFor("operador");
    expect((await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "borrar" })).status).toBe(400);
    expect((await call("PATCH", `/api/incidents/${i1.id}`, op, { accion: "tomar", nota: "x".repeat(501) })).status).toBe(400);
  });

  it("el comercial no ejecuta acciones; el admin sí", async () => {
    const { t, call, i1 } = await setup();
    expect((await call("PATCH", `/api/incidents/${i1.id}`, await t.tokenFor("comercial"), { accion: "cerrar" })).status).toBe(403);
    expect((await call("PATCH", `/api/incidents/${i1.id}`, await t.tokenFor("admin"), { accion: "tomar" })).status).toBe(200);
  });
});
