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
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicLlm } from "./llm/anthropic.ts";
import { createUnavailableLlm } from "./llm/unavailable.ts";
import { createSupabaseEmbedder } from "./rag/embedder.ts";
import { createPgvectorKb, createStaticKb } from "./rag/kb.ts";
import { createLeadsAgent } from "./leads/agent.ts";
import { deliverDue, deliverLead } from "./leads/delivery.ts";
import { startInterval } from "./server/scheduler.ts";
const env = readEnv(process.env);
const db = createDb(env.databaseUrl);
// Las rutas generadas abren su propia conexión al importarse (api/src/db/client.ts usa DATABASE_URL).
const { routes } = await import("../../../api/src/router.ts");

const mailer = env.smtp ? createMailer(createSmtpTransport(env.smtp), { from: env.smtp.from }) : null;
if (!mailer) console.warn("SMTP_* ausentes: los leads no se entregarán por email");
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

const llm = env.anthropicApiKey
  ? createAnthropicLlm(new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 2, timeout: 20_000 }))
  : createUnavailableLlm();
if (!env.anthropicApiKey) console.warn("ANTHROPIC_API_KEY ausente: el Agente 1 responderá con el mensaje de respaldo");

const kb = env.embed ? createPgvectorKb(db, createSupabaseEmbedder(env.embed)) : createStaticKb([]);
if (!env.embed) console.warn("SUPABASE_URL/EMBED_SECRET ausentes: FAQs sin base de conocimiento");

const delivery = { db, mailer, webhook: env.leadsWebhook, backofficeUrl: env.backofficeUrl };
const leadsAgent = createLeadsAgent({
  db, llm, kb, scoring: env.scoringRules,
  send: (msg) => {
    const ch = channels[msg.channel];
    if (!ch) throw new Error(`canal ${msg.channel} no configurado`);
    return ch.send(msg);
  },
  notifyNow: async (leadId) => { await deliverLead(delivery, leadId); },
});

const pipeline = createPipeline({
  db,
  defaultMarket: env.defaultMarket,
  contactLimiter: createRateLimiter({ limit: 20, windowMs: 60_000 }),
  dispatch: leadsAgent,
  background: true,
});

startInterval(() => deliverDue(delivery), 15 * 60_000, "entrega-leads");

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
