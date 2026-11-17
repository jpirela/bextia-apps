import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { createSession, loginErrorMessage, REFRESH_KEY, safeSessionStorage, type Session, type TokenStorage } from "./session";

const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (claims: object) => `${b64url({ alg: "ES256" })}.${b64url(claims)}.firma`;
const AT1 = jwt({ email: "ana@bextia.test", n: 1 });
const AT2 = jwt({ email: "ana@bextia.test", n: 2 });
const grant = (access_token: string, refresh_token: string) => ({ access_token, refresh_token, expires_in: 3600, role: "admin" });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function memoryStorage(): TokenStorage & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
}
const throwingStorage: TokenStorage = {
  getItem: () => { throw new DOMException("bloqueado", "SecurityError"); },
  setItem: () => { throw new DOMException("lleno", "QuotaExceededError"); },
  removeItem: () => { throw new DOMException("bloqueado", "SecurityError"); },
};

type Handler = (body: Record<string, string> | undefined, init: RequestInit) => Response | Promise<Response>;
const DEFAULT_ROUTES: Record<string, Handler> = {
  "/api/auth/login": (b) => (b?.password === "buena" ? json(grant(AT1, "rt-1")) : json({ error: "unauthorized" }, 401)),
  "/api/auth/refresh": (b) => (b?.refresh_token === "rt-1" || b?.refresh_token === "rt-0" ? json(grant(AT2, "rt-2")) : json({ error: "unauthorized" }, 401)),
  "/api/auth/logout": () => new Response(null, { status: 204 }),
};

function setup(opts: { routes?: Record<string, Handler>; storage?: TokenStorage | null } = {}) {
  let t = 1_700_000_000_000;
  const timers: { fn: () => void; ms: number }[] = [];
  const routes = { ...DEFAULT_ROUTES, ...opts.routes };
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    const h = routes[new URL(url).pathname];
    if (!h) return json({ error: "not_found" }, 404);
    return h(init.body ? JSON.parse(String(init.body)) : undefined, init);
  });
  const storage = opts.storage === undefined ? memoryStorage() : opts.storage;
  const s = createSession({
    baseUrl: "https://api.test", fetch: f as never, storage, now: () => t,
    schedule: (fn, ms) => {
      const e = { fn, ms };
      timers.push(e);
      return () => { const i = timers.indexOf(e); if (i >= 0) timers.splice(i, 1); };
    },
  });
  const seen: (Session | null)[] = [];
  s.subscribe((x) => seen.push(x));
  const pathsCalled = () => f.mock.calls.map((c) => new URL(c[0] as string).pathname);
  return { s, f, storage, timers, seen, pathsCalled, advance: (ms: number) => { t += ms; } };
}

afterEach(() => vi.restoreAllMocks());

describe("login", () => {
  it("access token en memoria, refresh token en sessionStorage, notifica y programa el refresh", async () => {
    const { s, f, storage, timers, seen } = setup();
    const session = await s.login("ana@bextia.test", "buena");
    expect(session).toMatchObject({ accessToken: AT1, role: "admin", email: "ana@bextia.test" });
    expect(await s.getToken()).toBe(AT1);
    expect((storage as ReturnType<typeof memoryStorage>).m.get(REFRESH_KEY)).toBe("rt-1");
    expect([...(storage as ReturnType<typeof memoryStorage>).m.values()]).not.toContain(AT1); // el access token no se persiste
    expect(seen.at(-1)).toMatchObject({ role: "admin" });
    expect(timers.map((x) => x.ms)).toEqual([3600_000 - 60_000]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/auth/login");
    expect(JSON.parse(String(init.body))).toEqual({ email: "ana@bextia.test", password: "buena" });
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("credenciales malas: ApiError 401, sin sesión ni storage", async () => {
    const { s, storage } = setup();
    await expect(s.login("ana@bextia.test", "mala")).rejects.toMatchObject({ status: 401 });
    expect(s.current()).toBeNull();
    expect((storage as ReturnType<typeof memoryStorage>).m.size).toBe(0);
  });

  it("una respuesta con rol inválido no abre sesión", async () => {
    const { s } = setup({ routes: { "/api/auth/login": () => json({ ...grant(AT1, "rt-1"), role: "root" }) } });
    await expect(s.login("ana@bextia.test", "buena")).rejects.toBeInstanceOf(ApiError);
    expect(s.current()).toBeNull();
  });

  it("mensajes de error en español y genéricos", () => {
    expect(loginErrorMessage(new ApiError(401, {}))).toBe("Credenciales inválidas");
    expect(loginErrorMessage(new ApiError(400, {}))).toBe("Credenciales inválidas");
    expect(loginErrorMessage(new ApiError(429, {}))).toMatch(/Demasiados intentos/);
    expect(loginErrorMessage(new ApiError(502, {}))).toMatch(/No se pudo conectar/);
    expect(loginErrorMessage(new TypeError("Failed to fetch"))).toMatch(/No se pudo conectar/);
  });
});

describe("refresh", () => {
  it("getToken refresca cerca del vencimiento, una sola llamada aunque sean concurrentes, y rota el refresh token", async () => {
    const { s, storage, pathsCalled, advance } = setup();
    await s.login("ana@bextia.test", "buena");
    advance(3600_000 - 30_000); // dentro del margen de 60 s
    const [a, b] = await Promise.all([s.getToken(), s.getToken()]);
    expect(a).toBe(AT2);
    expect(b).toBe(AT2);
    expect(pathsCalled().filter((p) => p === "/api/auth/refresh")).toHaveLength(1);
    expect((storage as ReturnType<typeof memoryStorage>).m.get(REFRESH_KEY)).toBe("rt-2");
  });

  it("el temporizador programado dispara el refresh", async () => {
    const { s, timers, pathsCalled } = setup();
    await s.login("ana@bextia.test", "buena");
    timers[0].fn();
    await vi.waitFor(() => expect(s.current()?.accessToken).toBe(AT2));
    expect(pathsCalled()).toContain("/api/auth/refresh");
    expect(timers).toHaveLength(1); // el timer viejo se canceló y se programó uno nuevo
  });

  it("refresh rechazado (401): limpia todo y notifica null", async () => {
    const { s, storage, seen } = setup({ routes: { "/api/auth/refresh": () => json({ error: "unauthorized" }, 401) } });
    await s.login("ana@bextia.test", "buena");
    expect(await s.refresh()).toBeNull();
    expect(s.current()).toBeNull();
    expect((storage as ReturnType<typeof memoryStorage>).m.size).toBe(0);
    expect(seen.at(-1)).toBeNull();
  });

  it("red caída o 502: conserva el refresh token y el access token vigente", async () => {
    for (const fail of [() => json({ error: "upstream" }, 502), () => { throw new TypeError("Failed to fetch"); }]) {
      const { s, storage } = setup({ routes: { "/api/auth/refresh": fail } });
      await s.login("ana@bextia.test", "buena");
      expect(await s.refresh()).toBe(AT1);
      expect(s.current()?.accessToken).toBe(AT1);
      expect((storage as ReturnType<typeof memoryStorage>).m.get(REFRESH_KEY)).toBe("rt-1");
    }
  });
});

describe("restore", () => {
  it("con refresh token guardado recupera la sesión; sin él no llama a la red", async () => {
    const storage = memoryStorage();
    storage.setItem(REFRESH_KEY, "rt-0");
    const withToken = setup({ storage });
    expect(await withToken.s.restore()).toMatchObject({ accessToken: AT2, role: "admin" });
    const empty = setup();
    expect(await empty.s.restore()).toBeNull();
    expect(empty.f).not.toHaveBeenCalled();
  });

  it("restore concurrente (StrictMode) hace un solo refresh", async () => {
    const storage = memoryStorage();
    storage.setItem(REFRESH_KEY, "rt-0");
    const { s, pathsCalled } = setup({ storage });
    await Promise.all([s.restore(), s.restore()]);
    expect(pathsCalled().filter((p) => p === "/api/auth/refresh")).toHaveLength(1);
  });
});

describe("logout", () => {
  it("limpia memoria, storage y temporizador, notifica null y llama /api/auth/logout con el bearer", async () => {
    const { s, f, storage, timers, seen } = setup();
    await s.login("ana@bextia.test", "buena");
    await s.logout();
    expect(s.current()).toBeNull();
    expect(await s.getToken()).toBeNull();
    expect((storage as ReturnType<typeof memoryStorage>).m.size).toBe(0);
    expect(timers).toHaveLength(0);
    expect(seen.at(-1)).toBeNull();
    const [url, init] = f.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/auth/logout");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${AT1}`);
    expect(await s.refresh()).toBeNull(); // no queda refresh token en memoria
  });

  it("si la red falla, el logout local igual se completa", async () => {
    const { s, storage } = setup({ routes: { "/api/auth/logout": () => { throw new TypeError("Failed to fetch"); } } });
    await s.login("ana@bextia.test", "buena");
    await expect(s.logout()).resolves.toBeUndefined();
    expect(s.current()).toBeNull();
    expect((storage as ReturnType<typeof memoryStorage>).m.size).toBe(0);
  });
});

describe("sessionStorage que lanza", () => {
  it("login, refresh y logout funcionan solo en memoria; restore devuelve null", async () => {
    const { s, advance } = setup({ storage: throwingStorage });
    await expect(s.login("ana@bextia.test", "buena")).resolves.toMatchObject({ role: "admin" });
    advance(3600_000);
    expect(await s.getToken()).toBe(AT2); // el refresh token quedó en memoria
    await expect(s.logout()).resolves.toBeUndefined();
    expect(await setup({ storage: throwingStorage }).s.restore()).toBeNull();
  });

  it("safeSessionStorage devuelve null si acceder a sessionStorage lanza", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new DOMException("bloqueado", "SecurityError"); } });
    try {
      expect(safeSessionStorage()).toBeNull();
    } finally {
      if (desc) Object.defineProperty(globalThis, "sessionStorage", desc);
      else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});

describe("ronda 1", () => {
  it("I1: un refresh en vuelo no resucita la sesión tras un logout", async () => {
    let release!: (r: Response) => void;
    const hung = new Promise<Response>((res) => { release = res; });
    const { s, storage, timers, seen } = setup({ routes: { "/api/auth/refresh": () => hung } });
    await s.login("ana@bextia.test", "buena");
    const pending = s.refresh();
    await s.logout();
    const before = seen.length;
    release(json(grant(AT2, "rt-2")));
    expect(await pending).toBeNull();
    expect(s.current()).toBeNull();
    expect((storage as ReturnType<typeof memoryStorage>).m.has(REFRESH_KEY)).toBe(false);
    expect(timers).toHaveLength(0);
    expect(seen).toHaveLength(before);
  });

  it("I1: un refresh en vuelo no pisa un login nuevo", async () => {
    let release!: (r: Response) => void;
    const hung = new Promise<Response>((res) => { release = res; });
    const { s, storage } = setup({ routes: { "/api/auth/refresh": () => hung } });
    await s.login("ana@bextia.test", "buena");
    const pending = s.refresh();
    await s.login("ana@bextia.test", "buena");
    release(json(grant(AT2, "rt-2")));
    await pending;
    expect(s.current()?.accessToken).toBe(AT1);
    expect((storage as ReturnType<typeof memoryStorage>).m.get(REFRESH_KEY)).toBe("rt-1");
  });

  it("M1: el timer nunca se programa en 0 ms aunque expires_in sea menor que el margen", async () => {
    const { s, timers } = setup({ routes: { "/api/auth/login": () => json({ ...grant(AT1, "rt-1"), expires_in: 30 }) } });
    await s.login("ana@bextia.test", "buena");
    expect(timers[0].ms).toBeGreaterThanOrEqual(5_000);
  });

  it("M4: el email con caracteres no ASCII se decodifica como UTF-8", async () => {
    const utf8 = (o: object) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const at = `${b64url({ alg: "ES256" })}.${utf8({ email: "josé@bextia.test" })}.firma`;
    const { s } = setup({ routes: { "/api/auth/login": () => json(grant(at, "rt-1")) } });
    expect((await s.login("x@bextia.test", "buena")).email).toBe("josé@bextia.test");
  });
});