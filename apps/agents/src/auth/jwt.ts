import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { jwk } from "hono/jwk";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";

export type Role = "admin" | "comercial" | "operador";
export const ROLES: readonly Role[] = ["admin", "comercial", "operador"];

/** TTL de la caché del JWKS remoto. */
export const JWKS_TTL_MS = 10 * 60 * 1000;
/** Tras un refresco fallido con claves viejas, espera esto antes de reintentar (evita un fetch por request). */
export const JWKS_RETRY_MS = 30 * 1000;

export interface AuthConfig {
  keys?: HonoJsonWebKey[]; // tests: claves estáticas
  jwksUri?: string;        // producción: JWKS de Supabase Auth (con caché)
  issuer?: string;
  fetch?: typeof fetch;    // inyectable (tests sin red)
  now?: () => number;      // reloj inyectable para la caché (ms)
}

export function supabaseAuthConfig(supabaseUrl: string): AuthConfig {
  const base = supabaseUrl.replace(/\/+$/, "");
  return { jwksUri: `${base}/auth/v1/.well-known/jwks.json`, issuer: `${base}/auth/v1` };
}

/**
 * Caché en memoria del JWKS. hono/jwk con `jwks_uri` hace fetch en cada request y un fallo da 500;
 * aquí se cachea por TTL, se reutilizan las claves viejas si el refresco falla y, si no hay
 * ninguna, se responde 401.
 */
export function cachedJwks(
  uri: string,
  opts: { fetch?: typeof fetch; now?: () => number; ttlMs?: number; retryMs?: number } = {},
): () => Promise<HonoJsonWebKey[]> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? JWKS_TTL_MS;
  const retry = opts.retryMs ?? JWKS_RETRY_MS;
  let cached: HonoJsonWebKey[] | null = null;
  let freshUntil = 0;
  let inflight: Promise<HonoJsonWebKey[]> | null = null;

  async function load(): Promise<HonoJsonWebKey[]> {
    const res = await doFetch(uri);
    if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
    const data = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(data.keys) || data.keys.length === 0) throw new Error("JWKS inválido");
    return data.keys as HonoJsonWebKey[];
  }

  return async () => {
    if (cached && now() < freshUntil) return cached;
    inflight ??= load()
      .then((keys) => { cached = keys; freshUntil = now() + ttl; return keys; })
      .finally(() => { inflight = null; });
    try {
      return await inflight;
    } catch {
      if (cached) { freshUntil = now() + retry; return cached; }
      throw new HTTPException(401, { message: "jwks unavailable" });
    }
  };
}

// Asimétrico únicamente: con ES256/RS256 no hay secreto compartido que filtrar.
export function verifyJwt(cfg: AuthConfig): MiddlewareHandler {
  if (!cfg.jwksUri && !cfg.keys?.length) throw new Error("verifyJwt requiere keys o jwksUri");
  const remote = cfg.jwksUri ? cachedJwks(cfg.jwksUri, { fetch: cfg.fetch, now: cfg.now }) : null;
  const staticKeys = cfg.keys ?? [];
  return jwk({
    keys: remote ? async () => [...staticKeys, ...(await remote())] : staticKeys,
    alg: ["ES256", "RS256"],
    verification: { aud: "authenticated", ...(cfg.issuer ? { iss: cfg.issuer } : {}) },
  });
}
