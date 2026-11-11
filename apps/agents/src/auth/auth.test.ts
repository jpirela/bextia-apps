import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { generateKeyPairSync } from "node:crypto";
import { sign } from "hono/utils/jwt/jwt";
import { verifyJwt, supabaseAuthConfig, type AuthConfig } from "./jwt.ts";
import { attachUser, requireRole, userFromClaims, type AuthEnv } from "./roles.ts";
import { createTestAuth, TEST_ISSUER } from "./test-keys.ts";

function app(cfg: AuthConfig) {
  const a = new Hono<AuthEnv>();
  a.onError((err, c) => (err instanceof HTTPException ? c.json({ error: "unauthorized" }, 401) : c.json({ error: "internal" }, 500)));
  a.use("*", verifyJwt(cfg), attachUser());
  a.get("/me", (c) => c.json(c.get("user")));
  a.get("/admin", requireRole("admin"), (c) => c.text("ok"));
  return a;
}
const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

describe("verifyJwt + attachUser", () => {
  it("acepta un token válido y expone el usuario", async () => {
    const t = await createTestAuth();
    const res = await app(t.config).request("/me", bearer(await t.tokenFor("comercial", "beto@bextia.test")));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: "beto@bextia.test", role: "comercial" });
  });

  it("401 sin token, con otra clave, vencido, con otra audiencia o con otro emisor", async () => {
    const t = await createTestAuth();
    const otra = await createTestAuth();
    const a = app(t.config);
    expect((await a.request("/me")).status).toBe(401);
    expect((await a.request("/me", bearer(await otra.tokenFor("admin")))).status).toBe(401);
    expect((await a.request("/me", bearer(await t.tokenFor("admin", undefined, { exp: 1 })))).status).toBe(401);
    expect((await a.request("/me", bearer(await t.tokenFor("admin", undefined, { aud: "anon" })))).status).toBe(401);
    expect((await a.request("/me", bearer(await t.tokenFor("admin", undefined, { iss: "https://otro/auth/v1" })))).status).toBe(401);
  });

  it("rechaza HS256 aunque el secreto coincida con algo", async () => {
    const t = await createTestAuth();
    const hs = await sign({ sub: "x", aud: "authenticated", iss: TEST_ISSUER, exp: Math.floor(Date.now() / 1000) + 60, app_metadata: { role: "admin" } }, "secreto", "HS256");
    expect((await app(t.config).request("/me", bearer(hs))).status).toBe(401);
  });

  it("403 sin rol o con rol desconocido; el rol de user_metadata no cuenta", async () => {
    const t = await createTestAuth();
    const a = app(t.config);
    expect((await a.request("/me", bearer(await t.tokenFor(null)))).status).toBe(403);
    expect((await a.request("/me", bearer(await t.tokenFor(null, "x@y.co", { app_metadata: { role: "root" } })))).status).toBe(403);
    expect((await a.request("/me", bearer(await t.tokenFor(null, "x@y.co", { user_metadata: { role: "admin" } })))).status).toBe(403);
  });

  it("requireRole", async () => {
    const t = await createTestAuth();
    const a = app(t.config);
    expect((await a.request("/admin", bearer(await t.tokenFor("operador")))).status).toBe(403);
    expect((await a.request("/admin", bearer(await t.tokenFor("admin")))).status).toBe(200);
  });
});

describe("userFromClaims / supabaseAuthConfig", () => {
  it("normaliza el email y exige sub", () => {
    expect(userFromClaims({ sub: "s", email: "Ana@X.CO", app_metadata: { role: "admin" } })).toEqual({ sub: "s", email: "ana@x.co", role: "admin" });
    expect(userFromClaims({ email: "a@b.co", app_metadata: { role: "admin" } })).toBeNull();
    expect(userFromClaims(null)).toBeNull();
  });
  it("arma JWKS y emisor desde la URL del proyecto", () => {
    expect(supabaseAuthConfig("https://abc.supabase.co/")).toEqual({
      jwksUri: "https://abc.supabase.co/auth/v1/.well-known/jwks.json", issuer: "https://abc.supabase.co/auth/v1",
    });
  });
});

it("las claves de prueba son ES256 (P-256)", () => {
  expect(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
});
