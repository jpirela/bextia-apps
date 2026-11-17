import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { kb_article, protocol, sales_agent } from "../db/schema.ts";
import { createApp } from "../server/app.ts";
import { createRateLimiter } from "../server/rate-limit.ts";
import { createTestAuth } from "../auth/test-keys.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

async function setup(embedder: { embed: (t: string[]) => Promise<number[][]> } | null = null) {
  const t = await createTestAuth();
  const pipeline = async () => ({ status: "routed" as const, conversationId: "c" });
  const app = createApp({
    auth: t.config, corsOrigins: [], channels: {}, pipeline,
    ipLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), api: { db, pipeline, embedder },
  });
  const admin = await t.tokenFor("admin");
  const call = (method: string, path: string, body?: unknown, token = admin) => app.request(`/api/config${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  return { t, call };
}

describe("config", () => {
  it("solo admin", async () => {
    const { t, call } = await setup();
    expect((await call("GET", "/sales_agent", undefined, await t.tokenFor("operador"))).status).toBe(403);
    expect((await call("GET", "/recurso_raro")).status).toBe(404);
  });

  it("comerciales: alta validada, email normalizado, baja lógica", async () => {
    const { call } = await setup();
    expect((await call("POST", "/sales_agent", { nombre: "", email: "no-es-email" })).status).toBe(400);
    const res = await call("POST", "/sales_agent", { nombre: "Beto", email: " Beto@Bextia.TEST ", destinos: ["Lisboa"], zona_horaria: "Europe/Madrid" });
    expect(res.status).toBe(201);
    const ag = await res.json();
    expect(ag.email).toBe("beto@bextia.test");
    expect((await call("POST", "/sales_agent", { nombre: "B", email: "x@y.co", zona_horaria: "Marte/Olimpo" })).status).toBe(400);
    expect((await call("DELETE", `/sales_agent/${ag.id}`)).status).toBe(200);
    const [row] = await db.select().from(sales_agent).where(eq(sales_agent.id, ag.id));
    expect(row.activo).toBe(false);
  });

  it("horarios: valida HH:MM y la zona horaria", async () => {
    const { call } = await setup();
    const ok = { mercado: "ES", zona_horaria: "Europe/Madrid", horario: { mon: [["09:00", "18:00"]] }, festivos: ["2026-12-25"] };
    expect((await call("POST", "/business_hours", ok)).status).toBe(201);
    expect((await call("POST", "/business_hours", { ...ok, mercado: "PT", horario: { mon: [["9", "25:00"]] } })).status).toBe(400);
    expect((await call("POST", "/business_hours", { ...ok, mercado: "MX", festivos: ["25/12"] })).status).toBe(400);
  });

  it("KB: al guardar se vacía el embedding y se recalcula si hay embedder", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => Array(384).fill(0.1))); // kb_article.embedding es vector(384)
    const { call } = await setup({ embed });
    const res = await call("POST", "/kb_article", { titulo: "Equipaje", contenido: "Una maleta de 23 kg", etiquetas: ["equipaje"] });
    expect(res.status).toBe(201);
    expect(embed).toHaveBeenCalledTimes(1);
    const { id } = await res.json();
    await call("PATCH", `/kb_article/${id}`, { contenido: "Dos maletas de 23 kg" });
    expect(embed).toHaveBeenCalledTimes(2);
    const [row] = await db.select().from(kb_article).where(eq(kb_article.id, id));
    expect(row.contenido).toBe("Dos maletas de 23 kg");
  });

  it("protocolo: solo tope y activo", async () => {
    const { call } = await setup();
    const [p] = await db.insert(protocol).values({ codigo: "traslado_no_presentado", nombre: "Taxi", version: 1, definicion: { pasos: [] }, tope_autorizado: "60.00" }).returning();
    const ok = await call("PATCH", `/protocol/${p.id}`, { tope_autorizado: 80 });
    expect(await ok.json()).toMatchObject({ tope_autorizado: "80.00" });
    expect((await call("PATCH", `/protocol/${p.id}`, { definicion: {} })).status).toBe(400);
    expect((await call("PATCH", `/protocol/${p.id}`, { tope_autorizado: -1 })).status).toBe(400);
    expect((await call("POST", "/protocol", { codigo: "x" })).status).toBe(404);
  });
});
