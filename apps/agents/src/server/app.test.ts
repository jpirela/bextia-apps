import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "./app.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { createJsonChannel } from "../channels/json-channel.ts";
import { createWhatsAppChannel } from "../channels/whatsapp.ts";
import { hmacSha256Hex, MissingContactError } from "../channels/errors.ts";
import type { ChannelAdapter, InboundMessage } from "../channels/types.ts";
import { createTestAuth } from "../auth/test-keys.ts";

async function deps(over: Partial<AppDeps> = {}): Promise<AppDeps> {
  const pipeline = over.pipeline ?? vi.fn(async () => ({ status: "routed" as const, conversationId: "c1" }));
  return {
    auth: (await createTestAuth()).config,
    corsOrigins: ["http://localhost:5173"],
    channels: {
      form: createJsonChannel({ name: "form", secret: "fs", send: async () => ({ externalId: "" }) }),
      whatsapp: createWhatsAppChannel({ appSecret: "as", accessToken: "t", phoneNumberId: "1" }),
    },
    pipeline,
    ipLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    whatsappVerifyToken: "vt",
    api: { db: {} as never, pipeline },
    ...over,
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
});
// Webhook de formulario con el secreto compartido correcto.
const form = (body: unknown, headers: Record<string, string> = {}) => json(body, { "x-webhook-secret": "fs", ...headers });

describe("onError", () => {
  it("responde 500 genérico y no registra el mensaje del error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp(await deps({ pipeline: async () => { throw new Error("insert into contact params: ana@x.com"); } }));
    const res = await app.request("/webhooks/form", form({ email: "ana@x.com", text: "hola" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("ana@x.com");
    spy.mockRestore();
  });
});

describe("createApp", () => {
  it("health responde sin token", async () => {
    const res = await createApp(await deps()).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("/api/* exige un JWT válido; health no", async () => {
    const t = await createTestAuth();
    const app = createApp({ ...(await deps()), auth: t.config });
    const sin = await app.request("/api/me");
    expect(sin.status).toBe(401);
    expect(await sin.json()).toEqual({ error: "unauthorized" }); // nunca el texto plano de hono/jwk
    expect((await app.request("/api/me", { headers: { authorization: "Bearer basura" } })).status).toBe(401);
    const ok = await app.request("/api/me", { headers: { authorization: `Bearer ${await t.tokenFor("admin")}` } });
    expect(ok.status).toBe(200);
    expect((await app.request("/api/health")).status).toBe(200);
  });

  it("el canal sim ya no se expone por /webhooks", async () => {
    const app = createApp(await deps());
    expect((await app.request("/webhooks/sim", json({ email: "a@b.co", text: "x" }))).status).toBe(404);
  });

  it("webhook de formulario pasa por el pipeline", async () => {
    const d = await deps();
    const res = await createApp(d).request("/webhooks/form", form({ email: "a@b.com", text: "hola" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["routed"] });
    expect(d.pipeline).toHaveBeenCalledTimes(1);
  });

  it("firma o secreto inválido → 401; payload inválido → 400; canal desconocido → 404", async () => {
    const app = createApp(await deps());
    expect((await app.request("/webhooks/form", json({ email: "a@b.com", text: "x" }, { "x-webhook-secret": "mal" }))).status).toBe(401);
    expect((await app.request("/webhooks/whatsapp", json({}, { "x-hub-signature-256": "sha256=00" }))).status).toBe(401);
    expect((await app.request("/webhooks/form", form({ text: "sin contacto" }))).status).toBe(400);
    expect((await app.request("/webhooks/telegram", json({}))).status).toBe(404);
  });

  it("en un lote, un mensaje inválido para el pipeline no impide procesar el siguiente", async () => {
    const pipeline = vi.fn(async (m: InboundMessage) => {
      if (m.externalId === "bad") throw new MissingContactError();
      return { status: "routed" as const, conversationId: "c1" };
    });
    const mk = (externalId: string): InboundMessage => ({ channel: "form", externalId, from: {}, text: "x", receivedAt: new Date() });
    const adapter = { ...(await deps()).channels.form!, receive: async () => [mk("bad"), mk("good")] } as ChannelAdapter;
    const res = await createApp(await deps({ pipeline, channels: { form: adapter } })).request("/webhooks/form", json({}));
    expect(res.status).toBe(200);
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(await res.json()).toEqual({ received: 2, outcomes: ["routed"] });
  });

  it("un SyntaxError dentro del pipeline no se disfraza de invalid_json (400)", async () => {
    const pipeline = vi.fn(async () => { throw new SyntaxError("boom"); });
    const res = await createApp(await deps({ pipeline })).request("/webhooks/form", form({ email: "a@b.com", text: "hola" }));
    expect(res.status).toBe(500);
  });

  it("el límite por IP usa el último salto de x-forwarded-for", async () => {
    const app = createApp(await deps({ ipLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) }));
    const b = { email: "a@b.com", text: "1" };
    expect((await app.request("/webhooks/form", form(b, { "x-forwarded-for": "9.9.9.1, 5.5.5.5" }))).status).toBe(200);
    // Mismo cliente real, primer salto falsificado distinto: sigue limitado.
    expect((await app.request("/webhooks/form", form(b, { "x-forwarded-for": "9.9.9.2, 5.5.5.5" }))).status).toBe(429);
  });

  it("WhatsApp firmado correctamente llega al pipeline", async () => {
    const d = await deps();
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
    const app = createApp(await deps());
    const ok = await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=99");
    expect(await ok.text()).toBe("99");
    expect((await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1")).status).toBe(403);
  });

  it("limita por IP en webhooks", async () => {
    const app = createApp(await deps({ ipLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) }));
    const h = { "x-forwarded-for": "1.2.3.4" };
    expect((await app.request("/webhooks/form", form({ email: "a@b.com", text: "1" }, h))).status).toBe(200);
    expect((await app.request("/webhooks/form", form({ email: "a@b.com", text: "2" }, h))).status).toBe(429);
  });
});
