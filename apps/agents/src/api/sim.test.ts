import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.ts";
import { createRateLimiter } from "../server/rate-limit.ts";
import { createSimulatorChannel } from "../channels/json-channel.ts";
import { createTestAuth } from "../auth/test-keys.ts";

async function setup(simulatorOn = true) {
  const t = await createTestAuth();
  const sim = createSimulatorChannel();
  const pipeline = vi.fn(async () => ({ status: "routed" as const, conversationId: "c1" }));
  const deps: AppDeps = {
    auth: t.config, corsOrigins: [], channels: { sim: sim.adapter }, pipeline,
    ipLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    api: { db: {} as never, pipeline, simulator: simulatorOn ? sim : null },
  };
  return { app: createApp(deps), t, pipeline, sim };
}
const req = (token: string, body?: unknown) => ({
  method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
});

describe("simulador detrás del login (P12)", () => {
  it("admin envía un mensaje y lee la bandeja; comercial no", async () => {
    const { app, t, pipeline, sim } = await setup();
    const admin = await t.tokenFor("admin");
    const res = await app.request("/api/sim/send", req(admin, { messageId: "s-1", email: "ana@example.com", name: "Ana", text: "hola" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["routed"] });
    expect(pipeline).toHaveBeenCalledTimes(1);
    sim.outbox.push({ channel: "sim", to: { email: "ana@example.com" }, text: "hola, Ana" });
    expect(await (await app.request("/api/sim/outbox", req(await t.tokenFor("operador")))).json()).toHaveLength(1);
    expect((await app.request("/api/sim/outbox", req(await t.tokenFor("comercial")))).status).toBe(403);
  });

  it("sin simulador activo: 404; las rutas viejas ya no existen", async () => {
    const { app, t } = await setup(false);
    expect((await app.request("/api/sim/outbox", req(await t.tokenFor("admin")))).status).toBe(404);
    const on = await setup(true);
    expect((await on.app.request("/sim/outbox")).status).toBe(404);
    expect((await on.app.request("/webhooks/sim", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
