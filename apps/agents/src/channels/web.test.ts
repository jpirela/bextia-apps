import { describe, expect, it } from "vitest";
import { createWebChannel } from "./web.ts";
import { signWidgetToken } from "../widget/token.ts";
import { InvalidPayloadError, SignatureError } from "./errors.ts";

const now = () => new Date(1_000);
const ch = createWebChannel({ tokenSecret: "s", send: async () => ({ externalId: "" }), now, newId: () => "id-1" });
const req = (body: unknown, token?: string) => new Request("http://x/webhooks/web", {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

describe("canal web con token", () => {
  it("toma la identidad del token, no del cuerpo", async () => {
    const token = signWidgetToken("s", { sub: "+34600000001", kind: "phone", exp: 5_000 });
    const [m] = await ch.receive(req({ text: "hola", email: "otro@example.com", name: "Ana" }, token));
    expect(m).toMatchObject({ channel: "web", externalId: "id-1", from: { phone: "+34600000001", name: "Ana" }, text: "hola" });
    expect(m.from.email).toBeUndefined();
  });
  it("sin token o token inválido → SignatureError", async () => {
    await expect(ch.receive(req({ text: "hola" }))).rejects.toBeInstanceOf(SignatureError);
    await expect(ch.receive(req({ text: "hola" }, "x.y"))).rejects.toBeInstanceOf(SignatureError);
  });
  it("sin texto → InvalidPayloadError", async () => {
    const token = signWidgetToken("s", { sub: "ana@example.com", kind: "email", exp: 5_000 });
    await expect(ch.receive(req({}, token))).rejects.toBeInstanceOf(InvalidPayloadError);
  });
});
