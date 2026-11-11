import { randomUUID } from "node:crypto";
import { validate, type FieldDescriptor } from "@jorgepirelarivas/clark";
import type { ChannelAdapter, InboundMessage } from "./types.ts";
import { InvalidPayloadError, SignatureError } from "./errors.ts";
import { verifyWidgetToken } from "../widget/token.ts";

const FIELDS = [
  { name: "messageId", type: "text" },
  { name: "name", type: "text" },
  { name: "text", type: "longtext", required: true },
  { name: "market", type: "text" },
] as FieldDescriptor[];

// P15: la identidad sale del token emitido tras el OTP; email/phone del cuerpo se ignoran.
export function createWebChannel(cfg: {
  tokenSecret: string;
  send: ChannelAdapter["send"];
  now?: () => Date;
  newId?: () => string;
}): ChannelAdapter {
  const now = cfg.now ?? (() => new Date());
  const newId = cfg.newId ?? randomUUID;
  return {
    name: "web",
    async receive(req) {
      const auth = req.headers.get("authorization") ?? "";
      const claims = auth.startsWith("Bearer ") ? verifyWidgetToken(cfg.tokenSecret, auth.slice(7), now().getTime()) : null;
      if (!claims) throw new SignatureError();
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") throw new InvalidPayloadError("JSON inválido");
      const r = validate(FIELDS, body);
      if (!r.ok) throw new InvalidPayloadError(r.issues.map((i) => `${i.field}:${i.code}`).join(", "));
      const from: InboundMessage["from"] = claims.kind === "email" ? { email: claims.sub } : { phone: claims.sub };
      if (typeof body.name === "string" && body.name) from.name = body.name;
      const msg: InboundMessage = {
        channel: "web", externalId: typeof body.messageId === "string" ? body.messageId : newId(),
        from, text: body.text as string, receivedAt: now(),
      };
      if (typeof body.market === "string" && body.market) msg.market = body.market;
      return [msg];
    },
    send: cfg.send,
  };
}
