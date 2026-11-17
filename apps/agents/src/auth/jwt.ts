import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { jwk } from "hono/jwk";
import { decodeHeader } from "hono/utils/jwt/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";

export type Role = "admin" | "comercial" | "operador";
export const ROLES: readonly Role[] = ["admin", "comercial", "operador"];

/** TTL de la caché del JWKS remoto. */
export const JWKS_TTL_MS = 10 * 60 * 1000;
/** Tras un refresco fallido con claves viejas, espera esto antes de reintentar (evita un fetch por request). */
export const JWKS_RETRY_MS = 30 * 1000;
/** Refresco forzado por kid desconocido con la caché fresca: como máximo uno por ventana. */
export const JWKS_FORCE_REFRESH_MS = 60 * 1000;

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
 * ninguna, se responde 401. Un `kid` desconocido con la caché fresca (rotación de claves)
 * fuerza un refresco, como máximo uno cada `forceRefreshMs`.
 */
export function cachedJwks(
  uri: string,
  opts: { fetch?: typeof fetch; now?: () => number; ttlMs?: number; retryMs?: number; forceRefreshMs?: number } = {},
): (kid?: string) => Promise<HonoJsonWebKey[]> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? JWKS_TTL_MS;
  const retry = opts.retryMs ?? JWKS_RETRY_MS;
  const forceWindow = opts.forceRefreshMs ?? JWKS_FORCE_REFRESH_MS;
  let cached: HonoJsonWebKey[] | null = null;
  let freshUntil = 0;
  let lastForced = Number.NEGATIVE_INFINITY;
  let inflight: Promise<HonoJsonWebKey[]> | null = null;

  async function load(): Promise<HonoJsonWebKey[]> {
    const res = await doFetch(uri);
    if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
    const data = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(data.keys) || data.keys.length === 0) throw new Error("JWKS inválido");
    return data.keys as HonoJsonWebKey[];
  }

  return async (kid) => {
    if (cached && now() < freshUntil) {
      const known = !kid || cached.some((k) => k.kid === kid);
      if (known || now() - lastForced < forceWindow) return cached;
      lastForced = now();
    }
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

function kidOf(authorization: string | undefined): string | undefined {
  const token = authorization?.match(/^bearer\s+(\S+)$/i)?.[1];
  if (!token) return undefined;
  try { return decodeHeader(token).kid; } catch { return undefined; }
}

// Asimétrico únicamente: con ES256/RS256 no hay secreto compartido que filtrar.
// `exp` obligatorio: hono solo lo valida si viene; un token sin vencimiento es 401.
export function verifyJwt(cfg: AuthConfig): MiddlewareHandler {
  const remote = cfg.jwksUri ? cachedJwks(cfg.jwksUri, { fetch: cfg.fetch, now: cfg.now }) : null;
  const staticKeys = cfg.keys ?? [];
  const verify = jwk({
    keys: remote ? async (c) => [...staticKeys, ...(await remote(kidOf(c.req.header("authorization"))))] : staticKeys,
    alg: ["ES256", "RS256"],
    verification: { aud: "authenticated", ...(cfg.issuer ? { iss: cfg.issuer } : {}) },
  });
  return async (c, next) =>
    verify(c, async () => {
      const exp = (c.get("jwtPayload") as { exp?: unknown } | undefined)?.exp;
      if (typeof exp !== "number") throw new HTTPException(401, { message: "exp requerido" });
      await next();
    });
}