import { randomUUID } from "node:crypto";
import { validate, type FieldDescriptor } from "@jorgepirelarivas/clark";
import type { Channel, ChannelAdapter, InboundMessage, OutboundMessage } from "./types.ts";
import { InvalidPayloadError, safeEqual, SignatureError } from "./errors.ts";

export interface JsonChannelConfig {
  name: Exclude<Channel, "whatsapp">;
  secret?: string; // si se define, se exige en la cabecera x-webhook-secret
  send: (msg: OutboundMessage) => Promise<{ externalId: string }>;
  newId?: () => string;
  now?: () => Date;
}

interface JsonInbound {
  messageId?: string; name?: string; email?: string; phone?: string; text: string; subject?: string; market?: string;
}

const INBOUND_FIELDS: FieldDescriptor[] = [
  { name: "messageId", type: "text" },
  { name: "name", type: "text" },
  { name: "email", type: "email" },
  { name: "phone", type: "text", pattern: "^\\+?[0-9]{7,15}$" },
  { name: "text", type: "longtext", required: true },
  { name: "subject", type: "text" },
  { name: "market", type: "text" },
] as FieldDescriptor[];

export function createJsonChannel(cfg: JsonChannelConfig): ChannelAdapter {
  const newId = cfg.newId ?? randomUUID;
  const now = cfg.now ?? (() => new Date());
  return {
    name: cfg.name,
    async receive(req) {
      if (cfg.secret !== undefined && !safeEqual(req.headers.get("x-webhook-secret") ?? "", cfg.secret)) {
        throw new SignatureError();
      }
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") throw new InvalidPayloadError("JSON inválido");
      const result = validate(INBOUND_FIELDS, body);
      if (!result.ok) throw new InvalidPayloadError(result.issues.map((i) => `${i.field}:${i.code}`).join(", "));
      const input = body as unknown as JsonInbound;
      if (!input.email && !input.phone) throw new InvalidPayloadError("se requiere email o phone");
      const from: InboundMessage["from"] = {};
      if (input.name) from.name = input.name;
      if (input.email) from.email = input.email.toLowerCase();
      if (input.phone) from.phone = input.phone;
      const msg: InboundMessage = {
        channel: cfg.name, externalId: input.messageId ?? newId(), from, text: input.text, receivedAt: now(),
      };
      if (input.subject) msg.subject = input.subject;
      if (input.market) msg.market = input.market;
      return [msg];
    },
    send: cfg.send,
  };
}

export function createSimulatorChannel(): { adapter: ChannelAdapter; outbox: OutboundMessage[] } {
  const outbox: OutboundMessage[] = [];
  const adapter = createJsonChannel({
    name: "sim",
    send: async (msg) => { outbox.push(msg); return { externalId: `sim-${outbox.length}` }; },
  });
  return { adapter, outbox };
}
