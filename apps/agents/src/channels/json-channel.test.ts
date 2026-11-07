import { describe, expect, it } from "vitest";
import { createJsonChannel, createSimulatorChannel } from "./json-channel.ts";
import { InvalidPayloadError, SignatureError } from "./errors.ts";

const now = () => new Date("2026-11-09T22:00:00Z");
const noSend = async () => ({ externalId: "" });

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://local/webhooks/x", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
  });
}

describe("canal JSON", () => {
  it("normaliza un formulario con secreto válido", async () => {
    const ch = createJsonChannel({ name: "form", secret: "s3", send: noSend, now });
    const msgs = await ch.receive(post(
      { messageId: "f-1", name: "Luis", email: "luis@example.com", text: "Viaje a Perú en marzo", market: "MX" },
      { "x-webhook-secret": "s3" },
    ));
    expect(msgs).toEqual([{
      channel: "form", externalId: "f-1", from: { name: "Luis", email: "luis@example.com" },
      text: "Viaje a Perú en marzo", market: "MX", receivedAt: now(),
    }]);
  });

  it("rechaza un secreto incorrecto", async () => {
    const ch = createJsonChannel({ name: "email", secret: "s3", send: noSend, now });
    await expect(ch.receive(post({ email: "a@b.com", text: "x" }, { "x-webhook-secret": "mal" })))
      .rejects.toBeInstanceOf(SignatureError);
  });

  it("exige texto y al menos email o teléfono", async () => {
    const ch = createJsonChannel({ name: "web", send: noSend, now });
    await expect(ch.receive(post({ text: "hola" }))).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(ch.receive(post({ email: "a@b.com" }))).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(ch.receive(post({ email: "no-es-email", text: "hola" }))).rejects.toBeInstanceOf(InvalidPayloadError);
  });

  it("genera externalId si el cliente no lo envía", async () => {
    const ch = createJsonChannel({ name: "web", send: noSend, now, newId: () => "gen-1" });
    const [m] = await ch.receive(post({ phone: "+5215500000000", text: "hola" }));
    expect(m.externalId).toBe("gen-1");
  });

  it("normaliza el teléfono a formato +dígitos", async () => {
    const ch = createJsonChannel({ name: "web", send: noSend, now, newId: () => "g" });
    const [a] = await ch.receive(post({ phone: "52 155-0000 0000", text: "hola" }));
    const [b] = await ch.receive(post({ phone: "+52 155 0000 0000", text: "hola" }));
    expect(a.from.phone).toBe("+5215500000000");
    expect(b.from.phone).toBe("+5215500000000");
  });

  it("el simulador guarda lo enviado en su bandeja", async () => {
    const sim = createSimulatorChannel();
    await sim.adapter.send({ channel: "sim", to: { email: "a@b.com" }, text: "respuesta" });
    expect(sim.outbox).toEqual([{ channel: "sim", to: { email: "a@b.com" }, text: "respuesta" }]);
  });

  it("rechaza secret vacío y exige secret en email y form", () => {
    expect(() => createJsonChannel({ name: "web", secret: "", send: noSend })).toThrow();
    expect(() => createJsonChannel({ name: "email", secret: "", send: noSend })).toThrow();
    // @ts-expect-error email requiere secret
    expect(() => createJsonChannel({ name: "email", send: noSend })).toThrow();
    // @ts-expect-error form requiere secret
    expect(() => createJsonChannel({ name: "form", send: noSend })).toThrow();
  });
});
