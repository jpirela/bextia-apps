import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { readEnv } from "./env.ts";
import { createDb } from "./db/index.ts";
import type { ChannelAdapter, Channel, OutboundMessage } from "./channels/types.ts";
import { createWhatsAppChannel } from "./channels/whatsapp.ts";
import { createJsonChannel, createSimulatorChannel } from "./channels/json-channel.ts";
import { createMailer, createSmtpTransport } from "./notify/mailer.ts";
import { createRateLimiter } from "./server/rate-limit.ts";
import { createPipeline } from "./server/pipeline.ts";
import { createApp } from "./server/app.ts";
import { supabaseAuthConfig } from "./auth/jwt.ts";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicLlm } from "./llm/anthropic.ts";
import { createUnavailableLlm } from "./llm/unavailable.ts";
import { createSupabaseEmbedder } from "./rag/embedder.ts";
import { createPgvectorKb, createStaticKb } from "./rag/kb.ts";
import { createLeadsAgent } from "./leads/agent.ts";
import { deliverDue, deliverLead } from "./leads/delivery.ts";
import { startInterval } from "./server/scheduler.ts";
import { createWebChannel } from "./channels/web.ts";
import { createIncidentsAgent } from "./incidents/agent.ts";
import { runDueTimers, escalateOverdue, closeStale } from "./incidents/sla.ts";
import type { Dispatch } from "./server/pipeline.ts";
const env = readEnv(process.env);
const db = createDb(env.databaseUrl);

const mailer = env.smtp ? createMailer(createSmtpTransport(env.smtp), { from: env.smtp.from }) : null;
if (!mailer) console.warn("SMTP_* ausentes: los leads no se entregarán por email");
const sendEmail = async (msg: OutboundMessage) => {
  if (!mailer || !msg.to.email) throw new Error("email: SMTP no configurado o falta destinatario");
  const r = await mailer.send({ to: msg.to.email, subject: msg.subject ?? "BEXTIA", text: msg.text });
  return { externalId: r.messageId };
};
const persistOnly = async () => ({ externalId: "" }); // web: el widget lee la conversación

const widgetTokenSecret = env.widgetTokenSecret ?? randomBytes(32).toString("hex");
if (!env.widgetTokenSecret) console.warn("WIDGET_TOKEN_SECRET ausente: secreto aleatorio (los tokens del widget no sobreviven a un reinicio)");

const channels: Partial<Record<Channel, ChannelAdapter>> = {
  web: createWebChannel({ tokenSecret: widgetTokenSecret, send: persistOnly }),
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
if (!env.embed) console.warn("EMBED_SECRET ausente: FAQs sin base de conocimiento");

const sendVia = async (msg: OutboundMessage) => {
  const ch = channels[msg.channel];
  if (!ch) throw new Error(`canal ${msg.channel} no configurado`);
  return ch.send(msg);
};
const delivery = { db, mailer, webhook: env.leadsWebhook, backofficeUrl: env.backofficeUrl };
const leadsAgent = createLeadsAgent({
  db, llm, kb, scoring: env.scoringRules,
  send: sendVia,
  notifyNow: async (leadId) => { await deliverLead(delivery, leadId); },
});

const providerChannels = { whatsapp: !!channels.whatsapp, email: !!mailer, sim: !!simulator };
const incidentsAgent = createIncidentsAgent({
  db, llm, kb, mailer, providerChannels, backofficeUrl: env.backofficeUrl, send: sendVia,
});
// Cada agente ignora las decisiones que no son suyas.
const dispatch: Dispatch = async (ctx) => { await leadsAgent(ctx); await incidentsAgent(ctx); };

const pipeline = createPipeline({
  db,
  defaultMarket: env.defaultMarket,
  contactLimiter: createRateLimiter({ limit: 20, windowMs: 60_000 }),
  dispatch,
  background: true,
});

startInterval(() => deliverDue(delivery), 15 * 60_000, "entrega-leads");
const runner = { db, send: sendVia, now: () => new Date(), mailer, backofficeUrl: env.backofficeUrl, providerChannels };
startInterval(() => runDueTimers(runner), 60_000, "incidencias-temporizadores");
startInterval(() => escalateOverdue(runner), 60_000, "incidencias-sla");
startInterval(() => closeStale(db, new Date()), 60_000, "incidencias-inactividad");

const app = createApp({
  auth: supabaseAuthConfig(env.supabaseUrl), // JWKS real de Supabase Auth + issuer
  authApi: { supabaseUrl: env.supabaseUrl, anonKey: env.supabaseAnonKey },
  corsOrigins: env.corsOrigins,
  channels,
  pipeline,
  ipLimiter: createRateLimiter({ limit: 120, windowMs: 60_000 }),
  whatsappVerifyToken: env.whatsapp?.verifyToken,
  widget: {
    db, tokenSecret: widgetTokenSecret,
    deliverOtp: async (d, codigo) => {
      const text = `Tu código de acceso de BEXTIA es ${codigo}. Vence en 10 minutos.`;
      if (d.kind === "email") {
        if (!mailer) throw new Error("sin SMTP para OTP");
        await mailer.send({ to: d.value, subject: "Tu código de acceso", text });
        return;
      }
      if (!channels.whatsapp) throw new Error("sin WhatsApp para OTP");
      await channels.whatsapp.send({ channel: "whatsapp", to: { phone: d.value }, text });
    },
  },
  api: { db, pipeline, simulator },
});

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`bextia-agentes escuchando en :${info.port} · canales: ${Object.keys(channels).join(", ")}`);
});
