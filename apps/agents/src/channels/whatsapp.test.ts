import { describe, expect, it, vi } from "vitest";
import { createWhatsAppChannel, verifyWhatsAppSubscription } from "./whatsapp.ts";
import { hmacSha256Hex, InvalidPayloadError, SignatureError } from "./errors.ts";

const SECRET = "app-secret";
const payload = {
  object: "whatsapp_business_account",
  entry: [{ changes: [{ value: {
    contacts: [{ wa_id: "34600000001", profile: { name: "Ana" } }],
    messages: [
      { id: "wamid.A", from: "34600000001", timestamp: "1762678800", type: "text", text: { body: "Hola, quiero ir a Japón" } },
      { id: "wamid.B", from: "34600000001", timestamp: "1762678801", type: "image", image: { id: "x" } },
    ],
  } }] }],
};

function signedRequest(body: string, signature: string): Request {
  return new Request("http://local/webhooks/whatsapp", {
    method: "POST", body, headers: { "x-hub-signature-256": signature, "content-type": "application/json" },
  });
}

const cfg = { appSecret: SECRET, accessToken: "tok", phoneNumberId: "123" };

describe("canal WhatsApp", () => {
  it("normaliza mensajes de texto y marca los no textuales como unsupported con firma válida", async () => {
    const body = JSON.stringify(payload);
    const msgs = await createWhatsAppChannel(cfg).receive(signedRequest(body, `sha256=${hmacSha256Hex(SECRET, body)}`));
    expect(msgs).toEqual([
      {
        channel: "whatsapp", externalId: "wamid.A", from: { phone: "+34600000001", name: "Ana" },
        text: "Hola, quiero ir a Japón", receivedAt: new Date(1762678800 * 1000),
      },
      {
        channel: "whatsapp", externalId: "wamid.B", from: { phone: "+34600000001", name: "Ana" },
        text: "[image]", unsupported: true, receivedAt: new Date(1762678801 * 1000),
      },
    ]);
  });

  it("convierte un mensaje no textual en unsupported (P4)", async () => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: {
      contacts: [{ wa_id: "34600111222", profile: { name: "Luz" } }],
      messages: [{ id: "wamid.IMG", from: "34600111222", timestamp: "1794100000", type: "image" }],
    } }] }] });
    const ch = createWhatsAppChannel({ appSecret: "as", accessToken: "t", phoneNumberId: "1" });
    const req = new Request("http://x/webhooks/whatsapp", {
      method: "POST", body, headers: { "x-hub-signature-256": `sha256=${hmacSha256Hex("as", body)}` },
    });
    const [m] = await ch.receive(req);
    expect(m).toMatchObject({ externalId: "wamid.IMG", text: "[image]", unsupported: true, from: { phone: "+34600111222", name: "Luz" } });
  });

  it("rechaza una firma inválida", async () => {
    const body = JSON.stringify(payload);
    await expect(createWhatsAppChannel(cfg).receive(signedRequest(body, "sha256=deadbeef")))
      .rejects.toBeInstanceOf(SignatureError);
  });

  it("envía texto por la Graph API", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 }));
    const ch = createWhatsAppChannel({ ...cfg, fetch: fetchMock as unknown as typeof fetch });
    const res = await ch.send({ channel: "whatsapp", to: { phone: "+34600000001" }, text: "¡Hola!" });
    expect(res.externalId).toBe("wamid.OUT");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v23.0/123/messages");
    expect(JSON.parse(String(init.body))).toEqual({
      messaging_product: "whatsapp", to: "34600000001", type: "text", text: { body: "¡Hola!" },
    });
  });

  it("responde el challenge de suscripción solo con el token correcto", () => {
    const ok = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "42" });
    expect(verifyWhatsAppSubscription(ok, "vt")).toBe("42");
    expect(verifyWhatsAppSubscription(ok, "otro")).toBeNull();
  });

  it("exige appSecret no vacío", () => {
    expect(() => createWhatsAppChannel({ ...cfg, appSecret: "" })).toThrow();
  });

  it("firma válida pero JSON inválido lanza InvalidPayloadError", async () => {
    const body = "no-json";
    await expect(createWhatsAppChannel(cfg).receive(signedRequest(body, `sha256=${hmacSha256Hex(SECRET, body)}`)))
      .rejects.toBeInstanceOf(InvalidPayloadError);
  });

  it("ignora cambios sin value", async () => {
    const body = JSON.stringify({ entry: [{ changes: [{}] }] });
    const msgs = await createWhatsAppChannel(cfg).receive(signedRequest(body, `sha256=${hmacSha256Hex(SECRET, body)}`));
    expect(msgs).toEqual([]);
  });

  it("incluye el cuerpo de la respuesta y usa timeout en el envío", async () => {
    const fetchMock = vi.fn(async () => new Response("token expirado", { status: 401 }));
    const ch = createWhatsAppChannel({ ...cfg, fetch: fetchMock as unknown as typeof fetch });
    await expect(ch.send({ channel: "whatsapp", to: { phone: "+34600000001" }, text: "x" }))
      .rejects.toThrow(/401 token expirado/);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
