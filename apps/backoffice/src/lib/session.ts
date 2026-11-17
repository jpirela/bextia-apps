// src/lib/session.ts
import { ApiError, postJson } from "./api";
import { isRole, type Role } from "./roles";

export interface Session { accessToken: string; expiresAt: number; role: Role; email: string | null }
export type TokenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const REFRESH_KEY = "bextia.refresh_token";

export interface SessionManager {
  current(): Session | null;
  subscribe(fn: (s: Session | null) => void): () => void;
  login(email: string, password: string): Promise<Session>;
  restore(): Promise<Session | null>;
  getToken(): Promise<string | null>;
  refresh(): Promise<string | null>;
  logout(): Promise<void>;
}

type Grant = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; role?: unknown };

// Acceder a sessionStorage puede lanzar (cookies bloqueadas, iframes, modo privado).
export function safeSessionStorage(): TokenStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

// Solo para mostrar el email en la UI: la firma la verifica la API, nunca el navegador.
function emailClaim(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // Genérico: no revela si el email existe ni si el usuario tiene rol.
    if (err.status === 400 || err.status === 401) return "Credenciales inválidas";
    if (err.status === 429) return "Demasiados intentos. Esperá 15 minutos e intentá de nuevo.";
  }
  return "No se pudo conectar con el servidor. Intentá de nuevo.";
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

export function createSession(opts: {
  baseUrl: string;
  fetch?: typeof fetch;
  storage?: TokenStorage | null;
  now?: () => number;
  skewMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}): SessionManager {
  const cfg = { baseUrl: opts.baseUrl, fetch: opts.fetch };
  const storage = opts.storage === undefined ? safeSessionStorage() : opts.storage;
  const now = opts.now ?? Date.now;
  const skew = opts.skewMs ?? 60_000;
  const schedule = opts.schedule ?? defaultSchedule;
  const listeners = new Set<(s: Session | null) => void>();
  let state: Session | null = null;
  let refreshToken: string | null = null; // también en memoria: si sessionStorage falla, el refresh sigue andando
  let cancelTimer: (() => void) | null = null;
  let inflight: Promise<string | null> | null = null;
  // Se incrementa en login() y clear(): un refresh que empezó en otra generación descarta su resultado.
  let gen = 0;

  const store = {
    get(): string | null {
      try { return storage?.getItem(REFRESH_KEY) ?? null; } catch { return null; }
    },
    set(v: string) {
      try { storage?.setItem(REFRESH_KEY, v); } catch { /* sin persistencia: la sesión vive solo en memoria */ }
    },
    clear() {
      try { storage?.removeItem(REFRESH_KEY); } catch { /* idem */ }
    },
  };
  const emit = () => { for (const fn of listeners) fn(state); };
  const stopTimer = () => { cancelTimer?.(); cancelTimer = null; };

  function apply(g: Grant | null): Session {
    if (!g || typeof g.access_token !== "string" || typeof g.refresh_token !== "string" || typeof g.expires_in !== "number" || !isRole(g.role)) {
      throw new ApiError(502, { error: "upstream" });
    }
    const expiresMs = g.expires_in * 1000;
    state = { accessToken: g.access_token, expiresAt: now() + expiresMs, role: g.role, email: emailClaim(g.access_token) };
    refreshToken = g.refresh_token;
    store.set(g.refresh_token);
    stopTimer();
    cancelTimer = schedule(() => { void refresh(); }, Math.max(5_000, expiresMs - Math.min(skew, expiresMs / 2)));
    emit();
    return state;
  }

  function clear() {
    gen += 1;
    inflight = null;
    state = null;
    refreshToken = null;
    stopTimer();
    store.clear();
    emit();
  }

  function refresh(): Promise<string | null> {
    if (inflight) return inflight;
    const rt = refreshToken ?? store.get();
    if (!rt) return Promise.resolve(null);
    const myGen = gen;
    inflight = (async () => {
      try {
        const grant = await postJson<Grant>(cfg, "/api/auth/refresh", { refresh_token: rt });
        if (gen !== myGen) return null; // hubo logout o login nuevo mientras tanto: se descarta el grant
        return apply(grant).accessToken;
      } catch (err) {
        if (gen !== myGen) return null;
        if (err instanceof ApiError && (err.status === 400 || err.status === 401)) {
          clear();
          return null;
        }
        // Red caída o 502: se conserva el refresh token; el access token sirve mientras no venza.
        return state && now() < state.expiresAt ? state.accessToken : null;
      } finally {
        if (gen === myGen) inflight = null;
      }
    })();
    return inflight;
  }

  return {
    current: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    async login(email, password) {
      gen += 1;
      inflight = null;
      return apply(await postJson<Grant>(cfg, "/api/auth/login", { email, password }));
    },
    async restore() {
      if (state) return state;
      if (!(refreshToken ?? store.get())) return null;
      await refresh();
      return state;
    },
    async getToken() {
      if (!state) return null;
      if (now() >= state.expiresAt - skew) return refresh();
      return state.accessToken;
    },
    refresh,
    async logout() {
      const token = state?.accessToken ?? null;
      clear();
      if (token) await postJson(cfg, "/api/auth/logout", undefined, token).catch(() => undefined);
    },
  };
}
