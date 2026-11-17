import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { contact, kpi_event, lead } from "../db/schema.ts";
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
  const app = createApp({ auth: t.config, corsOrigins: [], channels: {}, pipeline, ipLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }), api: { db, pipeline, now: () => NOW } });
  const [c] = await db.insert(contact).values({ nombre: "=HYPERLINK(\"x\")", email: "luz@example.com", telefono: "+34600111222" }).returning();
  await db.insert(lead).values([
    { contact_id: c.id, destino: "Lisboa", estado: "entregado", score: 80, created_at: new Date("2026-11-05T10:00:00Z") },
    { contact_id: c.id, destino: "Roma", estado: "nuevo", created_at: new Date("2026-09-01T10:00:00Z") },
  ]);
  await db.insert(kpi_event).values([
    { tipo: "first_response", agente: "leads", canal: "web", valor: 4.2, datos: { email: "luz@example.com" }, created_at: new Date("2026-11-07T10:00:00Z") },
  ]);
  const get = (path: string, role: "admin" | "operador" = "admin") => t.tokenFor(role).then((tk) => app.request(path, { headers: { authorization: `Bearer ${tk}` } }));
  return { get };
}

describe("GET /api/kpi", () => {
  it("últimos 30 días por omisión, sin PII", async () => {
    const { get } = await setup();
    const res = await get("/api/kpi");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rango).toEqual({ desde: "2026-10-09T12:00:00.000Z", hasta: "2026-11-08T12:00:00.000Z" });
    expect(body.leads).toHaveLength(1);
    expect(body.eventos[0]).toEqual({ tipo: "first_response", agente: "leads", canal: "web", valor: 4.2, created_at: "2026-11-07T10:00:00.000Z" });
    expect(JSON.stringify(body)).not.toContain("luz@example.com");
  });
  it("valida el rango y el rol", async () => {
    const { get } = await setup();
    expect((await get("/api/kpi?desde=2025-01-01&hasta=2026-11-08")).status).toBe(400);
    expect((await get("/api/kpi?desde=2026-11-08&hasta=2026-11-01")).status).toBe(400);
    expect((await get("/api/kpi", "operador")).status).toBe(403);
  });
});

describe("GET /api/export/leads.csv", () => {
  it("descarga CSV con cabecera y celdas neutralizadas", async () => {
    const { get } = await setup();
    const res = await get("/api/export/leads.csv?desde=2026-01-01");
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="leads-2026-11-08.csv"');
    const text = await res.text();
    const [head, ...lines] = text.trim().split("\r\n");
    expect(head).toBe("creado,estado,score,destino,mercado,contacto,email,telefono,comercial,entregado");
    expect(lines).toHaveLength(2);
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).toContain(",+34600111222,"); // M5: el teléfono E.164 no se prefija con '
  });
  it("solo admin", async () => {
    const { get } = await setup();
    expect((await get("/api/export/leads.csv", "operador")).status).toBe(403);
  });
});
