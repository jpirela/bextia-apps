import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { Channel, ChannelAdapter, InboundMessage } from "../channels/types.ts";
import { InvalidPayloadError, safeEqual, SignatureError } from "../channels/errors.ts";
import { bodyTooLarge, handleImport, MAX_BYTES, rowsFromAttachments, rowsFromRequest } from "../api/import.ts";
import { verifyWhatsAppSubscription } from "../channels/whatsapp.ts";
import type { InboundOutcome } from "./pipeline.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { registerWidgetRoutes, type WidgetDeps } from "./widget-routes.ts";
import type { AuthConfig } from "../auth/jwt.ts";
import { verifyJwt } from "../auth/jwt.ts";
import { attachUser, type AuthEnv } from "../auth/roles.ts";
import { createApiRoutes, type ApiDeps } from "../api/index.ts";
import { clientIp } from "../api/http.ts";
import { authRoutes, type AuthRoutesDeps } from "../api/auth.ts";

export interface AppDeps {
  auth: AuthConfig;
  corsOrigins: string[];
  channels: Partial<Record<Channel, ChannelAdapter>>;
  pipeline: (msg: InboundMessage) => Promise<InboundOutcome>;
  ipLimiter: RateLimiter;
  whatsappVerifyToken?: string;
  api: ApiDeps;
  widget?: WidgetDeps; // widget web (P15): OTP + token (sp3, se conserva)
  importToken?: string | null; // POST /import/bookings (sistemas del cliente); sin valor → 404
  importEmailSecret?: string | null; // POST /import/email (reenvío de correo); sin valor → 404
  authApi?: AuthRoutesDeps; // login del backoffice; sin ella /api/auth/* cae en el JWT (401)
}

export async function processInbound(
  c: Context, adapter: ChannelAdapter, req: Request, pipeline: (m: InboundMessage) => Promise<InboundOutcome>,
) {
  let messages: InboundMessage[];
  try {
    messages = await adapter.receive(req);
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
      outcomes.push(await pipeline(m));
    } catch (err) {
      if (!(err instanceof InvalidPayloadError)) throw err;
      console.warn(`webhook ${m.channel}: mensaje descartado por payload inválido`);
    }
  }
  return c.json({ received: messages.length, outcomes: outcomes.map((o) => o.status) });
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    // hono/jwk lanza HTTPException(401) con su propia respuesta en texto plano: se reemplaza por JSON
    // uniforme, sin detalles del token.
    if (err instanceof HTTPException && err.status === 401) return c.json({ error: "unauthorized" }, 401);
    if (err instanceof HTTPException && err.status === 403) return c.json({ error: "forbidden" }, 403);
    if (err instanceof HTTPException) return err.getResponse();
    // Sin message ni params: los errores de Drizzle/pg llevan PII en la consulta.
    console.error("unhandled error", err.name, (err as { code?: unknown }).code);
    return c.json({ error: "internal" }, 500);
  });
  app.use("*", cors({ origin: deps.corsOrigins, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));

  const ipGuard = async (c: Context, next: Next) => {
    if (!deps.ipLimiter.hit(clientIp(c))) return c.json({ error: "rate_limited" }, 429);
    await next();
  };

  // --- /api público (sin JWT) ---------------------------------------------------------------
  // Las sub-apps públicas de /api se montan AQUÍ, antes de `app.route("/api", api)`: Hono ejecuta
  // los handlers en orden de registro, así que una ruta pública ya respondió cuando llegaría el
  // middleware JWT. La Task 10a agrega `/api/auth/*` en este punto (p. ej. `app.route("/api/auth", …)`).
  app.get("/api/health", (c) => c.json({ ok: true }));
  // Pública (sin JWT): se registra antes que la sub-app /api para que su middleware no la alcance.
  if (deps.authApi) {
    app.use("/api/auth/*", ipGuard);
    app.route("/api/auth", authRoutes(deps.authApi));
  }

  // --- /api autenticado (JWT de Supabase + rol en app_metadata) ------------------------------
  const api = new Hono<AuthEnv>();
  api.use("*", verifyJwt(deps.auth), attachUser());
  api.route("/", createApiRoutes(deps.api));
  app.route("/api", api);

  // --- Importación externa (fuera de /api: token o secreto propio, no JWT) -------------------
  app.use("/import/*", async (c, next) => {
    if (!deps.ipLimiter.hit(`import:${clientIp(c)}`)) return c.json({ error: "rate_limited" }, 429);
    await next();
  });

  app.post("/import/bookings", bodyLimit({ maxSize: MAX_BYTES, onError: bodyTooLarge }), async (c) => {
    if (!deps.importToken) return c.json({ error: "not_found" }, 404);
    const auth = c.req.header("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), deps.importToken)) return c.json({ error: "unauthorized" }, 401);
    return handleImport(c, deps.api.db, () => rowsFromRequest(c));
  });

  // Reenvío de correo (p. ej. un webhook de entrada de email): solo adjuntos .csv.
  // Tope del body: 2 MB de CSV + ~33 % del base64 + margen del JSON.
  const EMAIL_BODY_LIMIT = Math.ceil(MAX_BYTES * 4 / 3) + 64 * 1024;
  app.post("/import/email", bodyLimit({ maxSize: EMAIL_BODY_LIMIT, onError: bodyTooLarge }), async (c) => {
    if (!deps.importEmailSecret) return c.json({ error: "not_found" }, 404);
    if (!safeEqual(c.req.header("x-import-secret") ?? "", deps.importEmailSecret)) return c.json({ error: "unauthorized" }, 401);
    return handleImport(c, deps.api.db, async () => rowsFromAttachments(await c.req.json().catch(() => null)));
  });

  app.use("/webhooks/*", ipGuard);
  app.use("/widget/*", ipGuard);
  if (deps.widget) registerWidgetRoutes(app, deps.widget);

  app.get("/webhooks/whatsapp", (c) => {
    const challenge = verifyWhatsAppSubscription(new URL(c.req.url).searchParams, deps.whatsappVerifyToken ?? "");
    return challenge === null ? c.text("forbidden", 403) : c.text(challenge, 200);
  });

  app.post("/webhooks/:channel", async (c) => {
    const name = c.req.param("channel") as Channel;
    const adapter = name === "sim" ? undefined : deps.channels[name]; // el simulador vive en /api/sim (P12)
    if (!adapter) return c.json({ error: "unknown_channel" }, 404);
    return processInbound(c, adapter, c.req.raw, deps.pipeline);
  });

  return app;
}
