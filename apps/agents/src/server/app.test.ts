import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "./app.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { createJsonChannel, createSimulatorChannel } from "../channels/json-channel.ts";
import { createWhatsAppChannel } from "../channels/whatsapp.ts";
import { hmacSha256Hex, InvalidPayloadError } from "../channels/errors.ts";

function deps(over: Partial<AppDeps> = {}): AppDeps {
  const sim = createSimulatorChannel();
  return {
    apiToken: "tok",
    corsOrigins: ["http://localhost:5173"],
    routes: { listLeads: async () => ({ status: 200, body: { data: [], meta: {} } }) },
    channels: {
      sim: sim.adapter,
      form: createJsonChannel({ name: "form", secret: "fs", send: async () => ({ externalId: "" }) }),
      whatsapp: createWhatsAppChannel({ appSecret: "as", accessToken: "t", phoneNumberId: "1" }),
    },
    pipeline: vi.fn(async () => ({ status: "routed" as const, conversationId: "c1" })),
    ipLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    whatsappVerifyToken: "vt",
    simulator: { outbox: sim.outbox },
    ...over,
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
});

describe("createApp", () => {
  it("health responde sin token", async () => {
    const res = await createApp(deps()).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("las rutas generadas exigen token y despachan por id", async () => {
    const app = createApp(deps());
    expect((await app.request("/api/listLeads", json({}))).status).toBe(401);
    const ok = await app.request("/api/listLeads", json({}, { authorization: "Bearer tok" }));
    expect(ok.status).toBe(200);
    expect((await app.request("/api/nope", json({}, { authorization: "Bearer tok" }))).status).toBe(404);
  });

  it("webhook del simulador pasa por el pipeline", async () => {
    const d = deps();
    const res = await createApp(d).request("/webhooks/sim", json({ email: "a@b.com", text: "hola" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["routed"] });
    expect(d.pipeline).toHaveBeenCalledTimes(1);
  });

  it("firma o secreto inválido → 401; payload inválido → 400; canal desconocido → 404", async () => {
    const app = createApp(deps());
    expect((await app.request("/webhooks/form", json({ email: "a@b.com", text: "x" }, { "x-webhook-secret": "mal" }))).status).toBe(401);
    expect((await app.request("/webhooks/whatsapp", json({}, { "x-hub-signature-256": "sha256=00" }))).status).toBe(401);
    expect((await app.request("/webhooks/sim", json({ text: "sin contacto" }))).status).toBe(400);
    expect((await app.request("/webhooks/telegram", json({}))).status).toBe(404);
  });

  it("un payload rechazado por el pipeline responde 400, no 500", async () => {
    const pipeline = vi.fn(async () => { throw new InvalidPayloadError("Mensaje sin identificador de contacto"); });
    const res = await createApp(deps({ pipeline })).request("/webhooks/sim", json({ email: "a@b.com", text: "hola" }));
    expect(res.status).toBe(400);
  });

  it("WhatsApp firmado correctamente llega al pipeline", async () => {
    const d = deps();
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [
      { id: "wamid.1", from: "34600000001", timestamp: "1762678800", type: "text", text: { body: "hola" } },
    ] } }] }] });
    const res = await createApp(d).request("/webhooks/whatsapp", {
      method: "POST", body, headers: { "x-hub-signature-256": `sha256=${hmacSha256Hex("as", body)}` },
    });
    expect(res.status).toBe(200);
    expect(d.pipeline).toHaveBeenCalledTimes(1);
  });

  it("verificación de suscripción de WhatsApp", async () => {
    const app = createApp(deps());
    const ok = await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=99");
    expect(await ok.text()).toBe("99");
    expect((await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1")).status).toBe(403);
  });

  it("limita por IP en webhooks", async () => {
    const app = createApp(deps({ ipLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) }));
    const h = { "x-forwarded-for": "1.2.3.4" };
    expect((await app.request("/webhooks/sim", json({ email: "a@b.com", text: "1" }, h))).status).toBe(200);
    expect((await app.request("/webhooks/sim", json({ email: "a@b.com", text: "2" }, h))).status).toBe(429);
  });

  it("expone la bandeja del simulador solo si está activo", async () => {
    expect((await createApp(deps()).request("/sim/outbox")).status).toBe(200);
    expect((await createApp(deps({ simulator: undefined })).request("/sim/outbox")).status).toBe(404);
  });
});
