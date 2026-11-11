import { describe, expect, it } from "vitest";
import { signWidgetToken, verifyWidgetToken } from "./token.ts";

const claims = { sub: "ana@example.com", kind: "email" as const, exp: 2_000 };

describe("token del widget", () => {
  it("firma y verifica", () => {
    expect(verifyWidgetToken("s", signWidgetToken("s", claims), 1_000)).toEqual(claims);
  });
  it("rechaza vencido, otra clave o manipulado", () => {
    const t = signWidgetToken("s", claims);
    expect(verifyWidgetToken("s", t, 2_001)).toBeNull();
    expect(verifyWidgetToken("otra", t, 1_000)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: "x@example.com" })).toString("base64url");
    expect(verifyWidgetToken("s", `${forged}.${sig}`, 1_000)).toBeNull();
    expect(verifyWidgetToken("s", body, 1_000)).toBeNull();
    expect(verifyWidgetToken("s", "basura", 1_000)).toBeNull();
  });
});
