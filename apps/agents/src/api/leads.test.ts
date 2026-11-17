import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { contact, conversation, lead, message, sales_agent } from "../db/schema.ts";
import { createApp } from "../server/app.ts";
import { createRateLimiter } from "../server/rate-limit.ts";
import { createTestAuth } from "../auth/test-keys.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

async function setup() {
  const t = await createTestAuth();
  const pipeline = async () => ({ status: "routed" as const, conversationId: "c" });
  const app = createApp({
    auth: t.config, corsOrigins: [], channels: {}, pipeline,
    ipLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), api: { db, pipeline },
  });
  const [beto] = await db.insert(sales_agent).values({ nombre: "Beto", email: "Beto@bextia.test" }).returning();
  const [caro] = await db.insert(sales_agent).values({ nombre: "Caro", email: "caro@bextia.test" }).returning();
  const [c] = await db.insert(contact).values({ nombre: "Luz", email: "luz@example.com", telefono: "+34600111222" }).returning();
  const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "web", agente: "leads" }).returning();
  await db.insert(message).values([
    { conversation_id: conv.id, canal: "web", direccion: "in", contenido: "Quiero ir a Lisboa", external_id: "m-1", created_at: new Date("2026-11-05T09:58:00Z") },
    { conversation_id: conv.id, canal: "web", direccion: "out", contenido: "¿Cuándo?", agente: "leads", external_id: "m-2", created_at: new Date("2026-11-05T09:59:00Z") },
  ]);
  const [l1] = await db.insert(lead).values({ contact_id: c.id, conversation_id: conv.id, destino: "Lisboa", estado: "asignado", sales_agent_id: beto.id, score: 80, created_at: new Date("2026-11-05T10:00:00Z") }).returning();
  const [l2] = await db.insert(lead).values({ contact_id: c.id, destino: "Roma", estado: "entregado", sales_agent_id: caro.id, score: 40, created_at: new Date("2026-11-07T10:00:00Z") }).returning();
  const get = async (path: string, token: string) => app.request(path, { headers: { authorization: `Bearer ${token}` } });
  const patch = async (path: string, token: string, body: unknown) =>
    app.request(path, { method: "PATCH", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  return { t, get, patch, beto, caro, l1, l2 };
}

describe("GET /api/leads", () => {
  it("admin ve todos, más recientes primero, con contacto y comercial", async () => {
    const { t, get } = await setup();
    const res = await get("/api/leads", await t.tokenFor("admin"));
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Array<{ destino: string; contacto: { email: string }; comercial: { nombre: string } }> };
    expect(data.map((d) => d.destino)).toEqual(["Roma", "Lisboa"]);
    expect(data[1]).toMatchObject({ contacto: { email: "luz@example.com" }, comercial: { nombre: "Beto" } });
  });

  it("filtra por estado y por rango de fechas", async () => {
    const { t, get } = await setup();
    const admin = await t.tokenFor("admin");
    expect((await (await get("/api/leads?estado=asignado", admin)).json()).data).toHaveLength(1);
    expect((await (await get("/api/leads?desde=2026-11-06", admin)).json()).data.map((d: { destino: string }) => d.destino)).toEqual(["Roma"]);
    expect((await get("/api/leads?desde=ayer", admin)).status).toBe(400);
    expect((await get("/api/leads?estado=raro", admin)).status).toBe(400);
  });

  it("el comercial ve solo sus leads (email sin distinguir mayúsculas)", async () => {
    const { t, get } = await setup();
    const { data } = await (await get("/api/leads", await t.tokenFor("comercial", "beto@bextia.test"))).json() as { data: Array<{ destino: string }> };
    expect(data.map((d) => d.destino)).toEqual(["Lisboa"]);
    const ajeno = await (await get("/api/leads", await t.tokenFor("comercial", "nadie@bextia.test"))).json();
    expect(ajeno.data).toEqual([]);
  });

  it("el operador no ve leads", async () => {
    const { t, get } = await setup();
    expect((await get("/api/leads", await t.tokenFor("operador"))).status).toBe(403);
  });
});

describe("GET /api/leads/:id", () => {
  it("incluye la conversación; el comercial no abre leads ajenos", async () => {
    const { t, get, l1, l2 } = await setup();
    const beto = await t.tokenFor("comercial", "beto@bextia.test");
    const res = await get(`/api/leads/${l1.id}`, beto);
    expect(res.status).toBe(200);
    expect((await res.json()).conversacion.map((m: { contenido: string }) => m.contenido)).toEqual(["Quiero ir a Lisboa", "¿Cuándo?"]);
    expect((await get(`/api/leads/${l2.id}`, beto)).status).toBe(404);
    expect((await get("/api/leads/no-es-uuid", beto)).status).toBe(404);
  });
});

describe("PATCH /api/leads/:id", () => {
  it("admin reasigna y cambia estado; valida; comercial no puede", async () => {
    const { t, patch, l1, caro } = await setup();
    const admin = await t.tokenFor("admin");
    const ok = await patch(`/api/leads/${l1.id}`, admin, { sales_agent_id: caro.id, estado: "entregado" });
    expect(ok.status).toBe(200);
    const patched = await ok.json();
    expect(patched).toMatchObject({ sales_agent_id: caro.id, estado: "entregado" });
    expect(patched.entregado_at).toBeTruthy(); // I11: PATCH a "entregado" fija entregado_at
    const again = await (await patch(`/api/leads/${l1.id}`, admin, { estado: "entregado" })).json();
    expect(again.entregado_at).toBe(patched.entregado_at); // M2: no se sobrescribe
    expect((await patch(`/api/leads/${l1.id}`, admin, { estado: "raro" })).status).toBe(400);
    expect((await patch(`/api/leads/${l1.id}`, admin, { sales_agent_id: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    expect((await patch(`/api/leads/${l1.id}`, await t.tokenFor("comercial", "beto@bextia.test"), { estado: "entregado" })).status).toBe(403);
  });
});
