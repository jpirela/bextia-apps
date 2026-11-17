import { Hono, type Context } from "hono";
import { validate, type FieldDescriptor } from "@jorgepirelarivas/clark";
import { ROLES, type Role } from "../auth/jwt.ts";
import { clientIp, invalid, readJson } from "./http.ts";

export interface LoginLimiter {
  blocked(key: string): number; // ms de bloqueo restantes; 0 = puede intentar
  fail(key: string): void;
  reset(key: string): void;
  size(): number;
}

// Ventana fija desde el primer fallo, en memoria: válido para una sola instancia (ver docs/deuda-tecnica.md).
export function createLoginLimiter(opts: { maxFailures?: number; windowMs?: number; maxEntries?: number; now?: () => number } = {}): LoginLimiter {
  const max = opts.maxFailures ?? 5;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const maxEntries = opts.maxEntries ?? 10_000;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { count: number; resetAt: number }>();
  const live = (key: string, t: number) => {
    const e = entries.get(key);
    if (e && e.resetAt <= t) {
      entries.delete(key);
      return undefined;
    }
    return e;
  };
  const sweep = (t: number) => {
    for (const [k, e] of entries) if (e.resetAt <= t) entries.delete(k);
    // Tope duro: si siguen sobrando, se desalojan las más antiguas (orden de inserción del Map).
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  return {
    blocked(key) {
      const t = now();
      const e = live(key, t);
      return e && e.count >= max ? e.resetAt - t : 0;
    },
    fail(key) {
      const t = now();
      const e = live(key, t);
      if (e) {
        e.count += 1;
        return;
      }
      if (entries.size >= maxEntries) sweep(t);
      entries.set(key, { count: 1, resetAt: t + windowMs });
    },
    reset(key) {
      entries.delete(key);
    },
    size: () => entries.size,
  };
}

export interface AuthRoutesDeps {
  supabaseUrl: string;
  anonKey: string; // clave publicable del proyecto; solo vive en la API
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  limiter?: LoginLimiter;
}

export interface AuthGrant { access_token: string; refresh_token: string; expires_in: number; role: Role }

const LOGIN_FIELDS = [
  { name: "email", type: "email", required: true },
  { name: "password", type: "text", required: true, min: 1, max: 1024 },
] as FieldDescriptor[];

const REFRESH_FIELDS = [{ name: "refresh_token", type: "text", required: true, min: 1, max: 4096 }] as FieldDescriptor[];

class UpstreamError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "UpstreamError";
  }
}

type Outcome = { kind: "ok"; grant: AuthGrant } | { kind: "rejected" } | { kind: "no_role"; accessToken: string };

function parseGrant(data: unknown): Outcome {
  const d = data as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; user?: { app_metadata?: { role?: unknown } } } | null;
  if (!d || typeof d.access_token !== "string" || typeof d.refresh_token !== "string" || typeof d.expires_in !== "number") {
    throw new UpstreamError("malformed");
  }
  // Solo app_metadata: user_metadata lo edita el propio usuario.
  const role = d.user?.app_metadata?.role;
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) return { kind: "no_role", accessToken: d.access_token };
  return { kind: "ok", grant: { access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in, role: role as Role } };
}

export function authRoutes(deps: AuthRoutesDeps): Hono {
  const base = deps.supabaseUrl.replace(/\/+$/, "");
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const limiter = deps.limiter ?? createLoginLimiter({ now: deps.now });

  async function upstream(path: string, init: RequestInit): Promise<Response> {
    try {
      return await f(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new UpstreamError(err instanceof Error ? err.name : "error"); // TimeoutError, AbortError, TypeError
    }
  }

  async function grant(type: "password" | "refresh_token", body: Record<string, string>): Promise<Outcome> {
    const res = await upstream(`/auth/v1/token?grant_type=${type}`, {
      method: "POST",
      headers: { apikey: deps.anonKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) throw new UpstreamError(`status_${res.status}`);
    if (!res.ok) return { kind: "rejected" };
    return parseGrant(await res.json().catch(() => null));
  }

  // Best-effort: un token vencido o ya revocado no es un error.
  async function revoke(token: string): Promise<void> {
    try {
      const res = await upstream("/auth/v1/logout?scope=local", {
        method: "POST",
        headers: { apikey: deps.anonKey, authorization: `Bearer ${token}` },
      });
      if (!res.ok && ![401, 403, 404].includes(res.status)) console.warn("auth: logout rechazado por Supabase", `status_${res.status}`);
    } catch (err) {
      console.warn("auth: logout sin respuesta de Supabase", err instanceof UpstreamError ? err.reason : "error");
    }
  }

  const upstreamDown = (c: Context, err: UpstreamError) => {
    console.warn("auth: Supabase Auth no disponible", err.reason);
    return c.json({ error: "upstream" }, 502);
  };
  const notJson = (c: Context) => invalid(c, [{ field: "body", code: "json", message: "Se esperaba un objeto JSON" }]);

  const r = new Hono();

  r.post("/login", async (c) => {
    const body = await readJson(c);
    if (!body) return notJson(c);
    const input = { ...body, email: typeof body.email === "string" ? body.email.trim().toLowerCase() : body.email };
    const v = validate(LOGIN_FIELDS, input, { locale: "es" });
    if (!v.ok) return invalid(c, v.issues);
    const email = input.email as string;
    const key = `${email}|${clientIp(c)}`; // nunca se loguea
    const wait = limiter.blocked(key);
    if (wait > 0) {
      c.header("retry-after", String(Math.ceil(wait / 1000)));
      return c.json({ error: "rate_limited" }, 429);
    }
    try {
      const out = await grant("password", { email, password: body.password as string });
      if (out.kind === "ok") {
        limiter.reset(key);
        return c.json(out.grant, 200);
      }
      limiter.fail(key);
      if (out.kind === "no_role") {
        console.warn("auth: login de un usuario sin rol válido");
        await revoke(out.accessToken);
      }
      return c.json({ error: "unauthorized" }, 401);
    } catch (err) {
      if (err instanceof UpstreamError) return upstreamDown(c, err);
      throw err;
    }
  });

  r.post("/refresh", async (c) => {
    const body = await readJson(c);
    if (!body) return notJson(c);
    const v = validate(REFRESH_FIELDS, body, { locale: "es" });
    if (!v.ok) return invalid(c, v.issues);
    try {
      const out = await grant("refresh_token", { refresh_token: body.refresh_token as string });
      if (out.kind === "ok") return c.json(out.grant, 200);
      if (out.kind === "no_role") await revoke(out.accessToken); // el rol se quitó después del login
      return c.json({ error: "unauthorized" }, 401);
    } catch (err) {
      if (err instanceof UpstreamError) return upstreamDown(c, err);
      throw err;
    }
  });

  r.post("/logout", async (c) => {
    const h = c.req.header("authorization") ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (token) await revoke(token);
    return c.body(null, 204);
  });

  return r;
}
