import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { authRoutes, createLoginLimiter, type AuthRoutesDeps } from "./auth.ts";

const SB = "https://abc.supabase.co";
const PASSWORD = "Secreta-123";

const USERS: Record<string, { app_metadata: Record<string, unknown>; user_metadata?: Record<string, unknown> }> = {
  "ana.perez@bextia.test": { app_metadata: { provider: "email", role: "admin" } },
  "sinrol@bextia.test": { app_metadata: { provider: "email" } },
  "root@bextia.test": { app_metadata: { provider: "email", role: "root" } },
  "meta@bextia.test": { app_metadata: { provider: "email" }, user_metadata: { role: "admin" } },
};

const grantBody = (email: string) => ({
  access_token: "at-SECRETO", token_type: "bearer", expires_in: 3600, expires_at: 0, refresh_token: "rt-SECRETO",
  user: { id: "u-1", email, app_metadata: USERS[email].app_metadata, user_metadata: USERS[email].user_metadata ?? {} },
});

type Override = (url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>;

// Supabase Auth falso: sin red.
function supabaseFake(override?: Override) {
  const calls: { url: URL; init: RequestInit; body: Record<string, string> | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : undefined;
    calls.push({ url, init, body });
    const custom = await override?.(url, init);
    if (custom) return custom;
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    const gt = url.searchParams.get("grant_type");
    if (gt === "password") {
      return body && USERS[body.email] && body.password === PASSWORD
        ? Response.json(grantBody(body.email))
        : Response.json({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 });
    }
    if (gt === "refresh_token") {
      return body?.refresh_token === "rt-SECRETO"
        ? Response.json(grantBody("ana.perez@bextia.test"))
        : Response.json({ code: 400, error_code: "refresh_token_not_found" }, { status: 400 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function setup(over: Partial<AuthRoutesDeps> = {}, override?: Override) {
  let t = 1_700_000_000_000;
  const sb = supabaseFake(override);
  const app = new Hono().route("/api/auth", authRoutes({
    supabaseUrl: `${SB}/`, anonKey: "anon-SECRETO", fetchImpl: sb.fetchImpl, now: () => t, ...over,
  }));
  return { app, sb, advance: (ms: number) => { t += ms; } };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const login = (email: string, password = PASSWORD, ip = "203.0.113.7") => post({ email, password }, { "x-forwarded-for": ip });

afterEach(() => vi.restoreAllMocks());

describe("POST /api/auth/login", () => {
  it("credenciales correctas: tokens y rol de app_metadata; normaliza el email", async () => {
    const { app, sb } = setup();
    const res = await app.request("/api/auth/login", login("  Ana.Perez@Bextia.TEST "));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: "at-SECRETO", refresh_token: "rt-SECRETO", expires_in: 3600, role: "admin" });
    expect(sb.calls).toHaveLength(1);
    const [call] = sb.calls;
    expect(call.url.toString()).toBe(`${SB}/auth/v1/token?grant_type=password`);
    expect(call.init.method).toBe("POST");
    expect(new Headers(call.init.headers).get("apikey")).toBe("anon-SECRETO");
    expect(new Headers(call.init.headers).get("authorization")).toBeNull();
    expect(call.body).toEqual({ email: "ana.perez@bextia.test", password: PASSWORD });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("credenciales incorrectas: 401 genérico", async () => {
    const { app } = setup();
    const res = await app.request("/api/auth/login", login("ana.perez@bextia.test", "mala"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("sin rol, rol desconocido o rol solo en user_metadata: 401 y revoca la sesión emitida", async () => {
    for (const email of ["sinrol@bextia.test", "root@bextia.test", "meta@bextia.test"]) {
      const { app, sb } = setup();
      const res = await app.request("/api/auth/login", login(email));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      const revoke = sb.calls.find((c) => c.url.pathname === "/auth/v1/logout");
      expect(revoke?.url.searchParams.get("scope")).toBe("local");
      expect(new Headers(revoke?.init.headers).get("authorization")).toBe("Bearer at-SECRETO");
    }
  });

  it("payload inválido: 400 con issues y sin llamar a Supabase", async () => {
    const { app, sb } = setup();
    const noJson = await app.request("/api/auth/login", post("{no es json"));
    expect(noJson.status).toBe(400);
    expect(await noJson.json()).toMatchObject({ error: "invalid" });
    const badEmail = await app.request("/api/auth/login", post({ email: "no-es-email", password: "x" }));
    expect(badEmail.status).toBe(400);
    expect((await badEmail.json()).issues.map((i: { field: string }) => i.field)).toContain("email");
    const noPass = await app.request("/api/auth/login", post({ email: "ana.perez@bextia.test" }));
    expect((await noPass.json()).issues.map((i: { field: string }) => i.field)).toContain("password");
    const longPass = await app.request("/api/auth/login", post({ email: "ana.perez@bextia.test", password: "x".repeat(1025) }));
    expect(longPass.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it("los errores de validación no repiten el email ni el password recibidos", async () => {
    const { app } = setup();
    const res = await app.request("/api/auth/login", post({ email: "no-es-email", password: `Secreta-${"y".repeat(1020)}` }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("no-es-email");
    expect(text).not.toContain("Secreta-");
    const typo = await app.request("/api/auth/login", post({ email: 7, password: PASSWORD }));
    expect(typo.status).toBe(400);
    expect(await typo.text()).not.toContain(PASSWORD);
  });
});

describe("rate limit del login", () => {
  it("5 fallos por email+IP → 429 sin consultar a Supabase; otra IP no queda bloqueada", async () => {
    const { app, sb } = setup();
    for (let i = 0; i < 5; i++) expect((await app.request("/api/auth/login", login("ana.perez@bextia.test", "mala"))).status).toBe(401);
    const blocked = await app.request("/api/auth/login", login("ANA.PEREZ@bextia.test"));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
    expect(blocked.headers.get("retry-after")).toBe("900");
    expect(sb.calls).toHaveLength(5);
    expect((await app.request("/api/auth/login", login("ana.perez@bextia.test", PASSWORD, "198.51.100.9"))).status).toBe(200);
  });

  it("un login correcto resetea el contador", async () => {
    const { app } = setup();
    for (let i = 0; i < 4; i++) await app.request("/api/auth/login", login("ana.perez@bextia.test", "mala"));
    expect((await app.request("/api/auth/login", login("ana.perez@bextia.test"))).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await app.request("/api/auth/login", login("ana.perez@bextia.test", "mala"))).status).toBe(401);
    expect((await app.request("/api/auth/login", login("ana.perez@bextia.test"))).status).toBe(200);
  });

  it("la ventana de 15 min vence (reloj inyectado)", async () => {
    const { app, advance } = setup();
    for (let i = 0; i < 5; i++) await app.request("/api/auth/login", login("ana.perez@bextia.test", "mala"));
    advance(14 * 60_000);
    expect((await app.request("/api/auth/login", login("ana.perez@bextia.test"))).status).toBe(429);
    advance(60_000);
    expect((await app.request("/api/auth/login", login("ana.perez@bextia.test"))).status).toBe(200);
  });

  it("las caídas de Supabase no cuentan como fallos", async () => {
    let down = true;
    const { app } = setup({}, () => (down ? new Response("boom", { status: 503 }) : undefined));
    for (let i = 0; i < 6; i++) expect((await app.request("/api/auth/login", login("ana.perez@bextia.test"))).status).toBe(502);
    down = false;
    expect((await app.request("/api/auth/login", login("ana.perez@bextia.test"))).status).toBe(200);
  });

  it("estructura acotada: barre vencidas y respeta el tope", () => {
    let t = 0;
    const lim = createLoginLimiter({ maxEntries: 3, windowMs: 1000, now: () => t });
    for (let i = 0; i < 10; i++) lim.fail(`k${i}`);
    expect(lim.size()).toBeLessThanOrEqual(3);
    t = 2000;
    lim.fail("nueva");
    expect(lim.size()).toBe(1);
    for (let i = 0; i < 4; i++) lim.fail("x");
    expect(lim.blocked("x")).toBe(0); // 4 fallos: todavía puede intentar
    lim.fail("x");
    expect(lim.blocked("x")).toBe(1000); // 5 fallos (máximo por defecto) → bloqueada hasta que venza la ventana
    lim.reset("x");
    expect(lim.blocked("x")).toBe(0);
  });
});

describe("POST /api/auth/refresh", () => {
  it("refresh válido: misma forma de respuesta", async () => {
    const { app, sb } = setup();
    const res = await app.request("/api/auth/refresh", post({ refresh_token: "rt-SECRETO" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: "at-SECRETO", refresh_token: "rt-SECRETO", expires_in: 3600, role: "admin" });
    expect(sb.calls[0].url.toString()).toBe(`${SB}/auth/v1/token?grant_type=refresh_token`);
    expect(sb.calls[0].body).toEqual({ refresh_token: "rt-SECRETO" });
  });

  it("refresh rechazado: 401; payload inválido: 400", async () => {
    const { app } = setup();
    const bad = await app.request("/api/auth/refresh", post({ refresh_token: "otro" }));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "unauthorized" });
    expect((await app.request("/api/auth/refresh", post({}))).status).toBe(400);
  });
});

describe("POST /api/auth/logout", () => {
  it("con bearer: revoca en Supabase (scope=local) y responde 204", async () => {
    const { app, sb } = setup();
    const res = await app.request("/api/auth/logout", { method: "POST", headers: { authorization: "Bearer at-SECRETO" } });
    expect(res.status).toBe(204);
    expect(sb.calls[0].url.toString()).toBe(`${SB}/auth/v1/logout?scope=local`);
    expect(new Headers(sb.calls[0].init.headers).get("authorization")).toBe("Bearer at-SECRETO");
    expect(new Headers(sb.calls[0].init.headers).get("apikey")).toBe("anon-SECRETO");
  });

  it("idempotente: sin bearer, token ya vencido o Supabase caído → 204", async () => {
    const { app, sb } = setup();
    expect((await app.request("/api/auth/logout", { method: "POST" })).status).toBe(204);
    expect(sb.calls).toHaveLength(0);
    const expired = setup({}, () => new Response(null, { status: 401 }));
    expect((await expired.app.request("/api/auth/logout", { method: "POST", headers: { authorization: "Bearer x" } })).status).toBe(204);
    const down = setup({}, () => { throw new TypeError("fetch failed"); });
    expect((await down.app.request("/api/auth/logout", { method: "POST", headers: { authorization: "Bearer x" } })).status).toBe(204);
  });
});

describe("Supabase caído", () => {
  it("5xx, 429, red caída o cuerpo malformado → 502 upstream", async () => {
    const cases: Override[] = [
      () => new Response("boom", { status: 500 }),
      () => new Response("slow down", { status: 429 }),
      () => { throw new TypeError("fetch failed"); },
      () => Response.json({ hola: 1 }),
    ];
    for (const c of cases) {
      const { app } = setup({}, c);
      const res = await app.request("/api/auth/login", login("ana.perez@bextia.test"));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "upstream" });
      const r2 = await app.request("/api/auth/refresh", post({ refresh_token: "rt-SECRETO" }));
      expect(r2.status).toBe(502);
    }
  });

  it("timeout: aborta el fetch y responde 502", async () => {
    const hang: Override = (_u, init) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    const { app } = setup({ timeoutMs: 20 }, hang);
    const res = await app.request("/api/auth/login", login("ana.perez@bextia.test"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream" });
  });
});

it("los logs no contienen email, contraseña, tokens ni apikey", async () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  const ok = setup();
  await ok.app.request("/api/auth/login", login("Ana.Perez@bextia.test"));
  await ok.app.request("/api/auth/login", login("Ana.Perez@bextia.test", "mala"));
  await ok.app.request("/api/auth/login", login("sinrol@bextia.test"));
  await ok.app.request("/api/auth/refresh", post({ refresh_token: "rt-SECRETO" }));
  await ok.app.request("/api/auth/refresh", post({ refresh_token: "rt-OTRO-SECRETO" }));
  const down = setup({}, () => { throw new TypeError("fetch failed"); });
  await down.app.request("/api/auth/login", login("Ana.Perez@bextia.test"));
  await down.app.request("/api/auth/logout", { method: "POST", headers: { authorization: "Bearer at-SECRETO" } });
  const out = spies.flatMap((s) => s.mock.calls).map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
  expect(out.length).toBeGreaterThan(0); // hubo logs (sin rol, upstream, logout): la aserción no es vacía
  for (const secret of ["ana.perez", "Ana.Perez", "sinrol@", PASSWORD, "mala", "SECRETO"]) expect(out).not.toContain(secret);
});
