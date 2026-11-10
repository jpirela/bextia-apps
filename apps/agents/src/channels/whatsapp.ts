import type { ChannelAdapter, InboundMessage } from "./types.ts";
import { hmacSha256Hex, InvalidPayloadError, safeEqual, SignatureError } from "./errors.ts";

export interface WhatsAppConfig {
  appSecret: string;
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  fetch?: typeof fetch;
}

interface WaPayload {
  entry?: Array<{ changes?: Array<{ value?: {
    contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
    messages?: Array<{ id: string; from: string; timestamp: string; type: string; text?: { body?: string } }>;
  } }> }>;
}

export function verifyWhatsAppSubscription(params: URLSearchParams, verifyToken: string): string | null {
  const ok = params.get("hub.mode") === "subscribe" && verifyToken !== ""
    && safeEqual(params.get("hub.verify_token") ?? "", verifyToken);
  return ok ? params.get("hub.challenge") ?? "" : null;
}

export function createWhatsAppChannel(cfg: WhatsAppConfig): ChannelAdapter {
  if (!cfg.appSecret) throw new Error("whatsapp: appSecret no puede ser vacío");
  const doFetch = cfg.fetch ?? fetch;
  const apiVersion = cfg.apiVersion ?? "v23.0";
  return {
    name: "whatsapp",
    async receive(req) {
      const raw = await req.text();
      const expected = `sha256=${hmacSha256Hex(cfg.appSecret, raw)}`;
      if (!safeEqual(req.headers.get("x-hub-signature-256") ?? "", expected)) throw new SignatureError();
      let payload: WaPayload;
      try { payload = JSON.parse(raw) as WaPayload; } catch { throw new InvalidPayloadError("JSON inválido"); }
      const out: InboundMessage[] = [];
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (!change.value) continue;
          const names = new Map((change.value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
          for (const m of change.value.messages ?? []) {
            const isText = m.type === "text" && !!m.text?.body;
            const name = names.get(m.from);
            const msg: InboundMessage = {
              channel: "whatsapp",
              externalId: m.id,
              from: name ? { phone: `+${m.from}`, name } : { phone: `+${m.from}` },
              text: isText ? (m.text?.body as string) : `[${m.type}]`,
              receivedAt: new Date(Number(m.timestamp) * 1000),
            };
            if (!isText) msg.unsupported = true;
            out.push(msg);
          }
        }
      }
      return out;
    },
    async send(msg) {
      if (!msg.to.phone) throw new Error("whatsapp: falta to.phone");
      const res = await doFetch(`https://graph.facebook.com/${apiVersion}/${cfg.phoneNumberId}/messages`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${cfg.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", to: msg.to.phone.replace(/^\+/, ""), type: "text", text: { body: msg.text },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`whatsapp: HTTP ${res.status} ${detail}`.trim());
      }
      const data = (await res.json()) as { messages?: Array<{ id: string }> };
      return { externalId: data.messages?.[0]?.id ?? "" };
    },
  };
}
