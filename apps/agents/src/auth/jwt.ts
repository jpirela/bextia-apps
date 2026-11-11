import type { MiddlewareHandler } from "hono";
import { jwk } from "hono/jwk";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";

export type Role = "admin" | "comercial" | "operador";
export const ROLES: readonly Role[] = ["admin", "comercial", "operador"];

export interface AuthConfig {
  keys?: HonoJsonWebKey[]; // tests
  jwksUri?: string;        // producción: JWKS de Supabase Auth
  issuer?: string;
}

export function supabaseAuthConfig(supabaseUrl: string): AuthConfig {
  const base = supabaseUrl.replace(/\/+$/, "");
  return { jwksUri: `${base}/auth/v1/.well-known/jwks.json`, issuer: `${base}/auth/v1` };
}

// Asimétrico únicamente: con ES256/RS256 no hay secreto compartido que filtrar.
export function verifyJwt(cfg: AuthConfig): MiddlewareHandler {
  return jwk({
    keys: cfg.keys,
    jwks_uri: cfg.jwksUri,
    alg: ["ES256", "RS256"],
    verification: { aud: "authenticated", ...(cfg.issuer ? { iss: cfg.issuer } : {}) },
  });
}
