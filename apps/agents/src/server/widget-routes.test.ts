import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { contact, conversation, message } from "../db/schema.ts";
import { registerWidgetRoutes } from "./widget-routes.ts";
import { verifyWidgetToken } from "../widget/token.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

function setup() {
  const sent: Array<{ value: string; codigo: string }> = [];
  const app = new Hono();
  registerWidgetRoutes(app, {
    db, tokenSecret: "s", now: () => new Date("2026-11-08T10:00:00Z"),
    deliverOtp: async (d, codigo) => { sent.push({ value: d.value, codigo }); },
  });
  const post = (path: string, body: unknown) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { app, sent, post };
}

describe("rutas del widget", () => {
  it("OTP → token → mensajes propios", async () => {
    const { app, sent, post } = setup();
    expect((await post("/widget/otp", { destino: "ana@example.com" })).status).toBe(202);
    expect(sent).toHaveLength(1);
    const bad = await post("/widget/token", { destino: "ana@example.com", codigo: "000000" });
    expect(bad.status).toBe(401);
    const ok = await post("/widget/token", { destino: "ana@example.com", codigo: sent[0].codigo });
    expect(ok.status).toBe(200);
    const { token } = await ok.json() as { token: string };
    expect(verifyWidgetToken("s", token, new Date("2026-11-08T10:01:00Z").getTime())).toMatchObject({ sub: "ana@example.com", kind: "email" });

    const [c] = await db.insert(contact).values({ email: "ana@example.com" }).returning();
    const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "web" }).returning();
    await db.insert(message).values({ conversation_id: conv.id, canal: "web", direccion: "out", contenido: "Hola Ana", external_id: "o1" });
    const res = await app.request("/widget/messages", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await res.json() as Array<{ contenido: string }>).map((m) => m.contenido)).toEqual(["Hola Ana"]);
  });
  it("OTP siempre 202 aunque falle el envío o se supere el límite; destino inválido 400", async () => {
    const app = new Hono();
    registerWidgetRoutes(app, { db, tokenSecret: "s", deliverOtp: async () => { throw new Error("smtp"); } });
    const post = (body: unknown) => app.request("/widget/otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (let i = 0; i < 4; i++) expect((await post({ destino: "ana@example.com" })).status).toBe(202);
    expect((await post({ destino: "no-es-destino" })).status).toBe(400);
  });
  it("mensajes sin token → 401", async () => {
    const { app } = setup();
    expect((await app.request("/widget/messages")).status).toBe(401);
  });
});
