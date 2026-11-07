import { serve } from "@hono/node-server";
import { readEnv } from "./env.ts";
import { createDb } from "./db/index.ts";
import type { ChannelAdapter, Channel, OutboundMessage } from "./channels/types.ts";
import { createWhatsAppChannel } from "./channels/whatsapp.ts";
import { createJsonChannel, createSimulatorChannel } from "./channels/json-channel.ts";
import { createMailer, createSmtpTransport } from "./notify/mailer.ts";
import { createRateLimiter } from "./server/rate-limit.ts";
import { createPipeline } from "./server/pipeline.ts";
import { createApp, type RouteHandler } from "./server/app.ts";

const env = readEnv(process.env);
const db = createDb(env.databaseUrl);
// Las rutas generadas abren su propia conexión al importarse (api/src/db/client.ts usa DATABASE_URL).
const { routes } = await import("../../../api/src/router.ts");

const mailer = env.smtp ? createMailer(createSmtpTransport(env.smtp), { from: env.smtp.from }) : null;
const sendEmail = async (msg: OutboundMessage) => {
  if (!mailer || !msg.to.email) throw new Error("email: SMTP no configurado o falta destinatario");
  const r = await mailer.send({ to: msg.to.email, subject: msg.subject ?? "BEXTIA", text: msg.text });
  return { externalId: r.messageId };
};
const persistOnly = async () => ({ externalId: "" }); // web: el widget lee la conversación

const channels: Partial<Record<Channel, ChannelAdapter>> = {
  web: createJsonChannel({ name: "web", send: persistOnly }),
};
if (env.whatsapp) channels.whatsapp = createWhatsAppChannel(env.whatsapp);
if (env.emailWebhookSecret) channels.email = createJsonChannel({ name: "email", secret: env.emailWebhookSecret, send: sendEmail });
if (env.formWebhookSecret) channels.form = createJsonChannel({ name: "form", secret: env.formWebhookSecret, send: sendEmail });
const simulator = env.simulatorEnabled ? createSimulatorChannel() : null;
if (simulator) channels.sim = simulator.adapter;

const pipeline = createPipeline({
  db,
  defaultMarket: env.defaultMarket,
  contactLimiter: createRateLimiter({ limit: 20, windowMs: 60_000 }),
});

const app = createApp({
  apiToken: env.apiToken,
  corsOrigins: env.corsOrigins,
  routes: routes as unknown as Record<string, RouteHandler>,
  channels,
  pipeline,
  ipLimiter: createRateLimiter({ limit: 120, windowMs: 60_000 }),
  whatsappVerifyToken: env.whatsapp?.verifyToken,
  simulator: simulator ? { outbox: simulator.outbox } : undefined,
});

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`bextia-agentes escuchando en :${info.port} · canales: ${Object.keys(channels).join(", ")}`);
});
