import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Channel, ChannelAdapter, InboundMessage, OutboundMessage } from "../channels/types.ts";
import { InvalidPayloadError, safeEqual, SignatureError } from "../channels/errors.ts";
import { verifyWhatsAppSubscription } from "../channels/whatsapp.ts";
import type { InboundOutcome } from "./pipeline.ts";
import type { RateLimiter } from "./rate-limit.ts";

export type RouteHandler = (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

export interface AppDeps {
  apiToken: string; // provisional hasta Supabase Auth (subproyecto 4)
  corsOrigins: string[];
  routes: Record<string, RouteHandler>;
  channels: Partial<Record<Channel, ChannelAdapter>>;
  pipeline: (msg: InboundMessage) => Promise<InboundOutcome>;
  ipLimiter: RateLimiter;
  whatsappVerifyToken?: string;
  simulator?: { outbox: OutboundMessage[] };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: deps.corsOrigins }));

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.use("/api/*", async (c, next) => {
    if (!safeEqual(c.req.header("authorization") ?? "", `Bearer ${deps.apiToken}`)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.post("/api/:id", async (c) => {
    const handler = deps.routes[c.req.param("id")];
    if (!handler) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "invalid_json" }, 400);
    const result = await handler(body as Record<string, unknown>);
    return c.json(result.body as object, result.status as ContentfulStatusCode);
  });

  app.use("/webhooks/*", async (c, next) => {
    // Render agrega la IP real del cliente al final de x-forwarded-for; los saltos anteriores los controla el cliente.
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const conn = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
    const ip = hops.at(-1) ?? conn ?? "unknown";
    if (!deps.ipLimiter.hit(ip)) return c.json({ error: "rate_limited" }, 429);
    await next();
  });

  app.get("/webhooks/whatsapp", (c) => {
    const challenge = verifyWhatsAppSubscription(new URL(c.req.url).searchParams, deps.whatsappVerifyToken ?? "");
    return challenge === null ? c.text("forbidden", 403) : c.text(challenge, 200);
  });

  app.post("/webhooks/:channel", async (c) => {
    const adapter = deps.channels[c.req.param("channel") as Channel];
    if (!adapter) return c.json({ error: "unknown_channel" }, 404);
    let messages: InboundMessage[];
    try {
      messages = await adapter.receive(c.req.raw);
    } catch (err) {
      if (err instanceof SignatureError) return c.json({ error: "invalid_signature" }, 401);
      if (err instanceof InvalidPayloadError) return c.json({ error: "invalid_payload", detail: err.message }, 400);
      if (err instanceof SyntaxError) return c.json({ error: "invalid_json" }, 400);
      throw err;
    }
    // Un mensaje inválido de un lote no debe impedir procesar el resto (ni provocar reintentos del proveedor).
    const outcomes: InboundOutcome[] = [];
    for (const m of messages) {
      try {
        outcomes.push(await deps.pipeline(m));
      } catch (err) {
        if (!(err instanceof InvalidPayloadError)) throw err;
        console.warn(`webhook ${m.channel}: mensaje descartado por payload inválido`);
      }
    }
    return c.json({ received: messages.length, outcomes: outcomes.map((o) => o.status) });
  });

  if (deps.simulator) {
    const outbox = deps.simulator.outbox;
    app.get("/sim/outbox", (c) => c.json(outbox));
  }

  return app;
}
