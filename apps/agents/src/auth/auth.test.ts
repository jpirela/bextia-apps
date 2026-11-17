import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { decodeHeader, sign } from "hono/utils/jwt/jwt";
import { verifyJwt, supabaseAuthConfig, JWKS_TTL_MS, JWKS_FORCE_REFRESH_MS, type AuthConfig } from "./jwt.ts";
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

it("las claves de prueba firman ES256 con el kid publicado", async () => {
  const t = await createTestAuth();
  const h = decodeHeader(await t.tokenFor("admin"));
  expect(h.alg).toBe("ES256");
  expect(h.kid).toBe(t.config.keys?.[0]?.kid);
});

describe("JWKS remoto con caché", () => {
  const URI = "https://test.supabase.co/auth/v1/.well-known/jwks.json";
  async function setup() {
    const t = await createTestAuth();
    let clock = 1_000_000;
    let falla = false;
    let llamadas = 0;
    let servidas = t.config.keys;
    const fetchStub = (async () => {
      llamadas++;
      if (falla) throw new Error("red caída");
      return new Response(JSON.stringify({ keys: servidas }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg: AuthConfig = { jwksUri: URI, issuer: TEST_ISSUER, fetch: fetchStub, now: () => clock };
    return {
      t, a: app(cfg),
      avanzar: (ms: number) => { clock += ms; },
      fallar: () => { falla = true; },
      llamadas: () => llamadas,
      servir: (keys: AuthConfig["keys"]) => { servidas = keys; },
    };
  }

  it("cachea el JWKS durante el TTL y lo refresca al vencer", async () => {
    const s = await setup();
    const tok = await s.t.tokenFor("admin");
    expect((await s.a.request("/me", bearer(tok))).status).toBe(200);
    expect((await s.a.request("/me", bearer(tok))).status).toBe(200);
    expect(s.llamadas()).toBe(1);
    s.avanzar(JWKS_TTL_MS + 1);
    expect((await s.a.request("/me", bearer(tok))).status).toBe(200);
    expect(s.llamadas()).toBe(2);
  });

  it("si el refresco falla con caché previa, sigue verificando con las claves viejas", async () => {
    const s = await setup();
    const tok = await s.t.tokenFor("operador");
    expect((await s.a.request("/me", bearer(tok))).status).toBe(200);
    s.fallar();
    s.avanzar(JWKS_TTL_MS + 1);
    expect((await s.a.request("/me", bearer(tok))).status).toBe(200);
    expect(s.llamadas()).toBe(2);
  });

  it("sin caché y con el fetch caído responde 401 unauthorized", async () => {
    const s = await setup();
    s.fallar();
    const res = await s.a.request("/me", bearer(await s.t.tokenFor("admin")));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("kid desconocido con caché fresca fuerza un refresco, como máximo uno cada 60 s", async () => {
    const s = await setup();
    const nueva = await createTestAuth();
    const ajena = await createTestAuth();
    expect((await s.a.request("/me", bearer(await s.t.tokenFor("admin")))).status).toBe(200);
    expect(s.llamadas()).toBe(1);
    s.servir([...(s.t.config.keys ?? []), ...(nueva.config.keys ?? [])]); // rotación en Supabase
    expect((await s.a.request("/me", bearer(await nueva.tokenFor("admin")))).status).toBe(200);
    expect(s.llamadas()).toBe(2);
    expect((await s.a.request("/me", bearer(await ajena.tokenFor("admin")))).status).toBe(401);
    expect(s.llamadas()).toBe(2); // dentro de la ventana: sin fetch
    s.avanzar(JWKS_FORCE_REFRESH_MS + 1);
    expect((await s.a.request("/me", bearer(await ajena.tokenFor("admin")))).status).toBe(401);
    expect(s.llamadas()).toBe(3);
  });
});

it("token sin exp: 401", async () => {
  const t = await createTestAuth();
  const res = await app(t.config).request("/me", bearer(await t.tokenFor("admin", undefined, { exp: undefined })));
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});