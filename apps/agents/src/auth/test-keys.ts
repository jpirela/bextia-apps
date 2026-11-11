// Solo para tests: par ES256 efímero y tokens con la forma de Supabase Auth.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { sign } from "hono/utils/jwt/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import type { AuthConfig, Role } from "./jwt.ts";

export const TEST_ISSUER = "https://test.supabase.co/auth/v1";

export async function createTestAuth() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = randomUUID();
  const pub = { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" } as HonoJsonWebKey;
  const priv = { ...privateKey.export({ format: "jwk" }), kid, alg: "ES256" } as HonoJsonWebKey;
  const config: AuthConfig = { keys: [pub], issuer: TEST_ISSUER };
  async function tokenFor(role: Role | null, email = `${role ?? "nadie"}@bextia.test`, over: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return sign({
      sub: randomUUID(), email, aud: "authenticated", iss: TEST_ISSUER, iat: now, exp: now + 3600,
      app_metadata: role ? { role } : {}, ...over,
    }, priv, "ES256");
  }
  return { config, tokenFor, privateJwk: priv };
}
