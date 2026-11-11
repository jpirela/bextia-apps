import { createHmac } from "node:crypto";
import { safeEqual } from "../channels/errors.ts";

export interface WidgetClaims { sub: string; kind: "email" | "phone"; exp: number }

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signWidgetToken(secret: string, claims: WidgetClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function verifyWidgetToken(secret: string, token: string, now = Date.now()): WidgetClaims | null {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, sign(secret, body))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as WidgetClaims;
    if (typeof c.sub !== "string" || (c.kind !== "email" && c.kind !== "phone") || typeof c.exp !== "number") return null;
    return c.exp > now ? c : null;
  } catch {
    return null;
  }
}
