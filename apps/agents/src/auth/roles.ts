import type { MiddlewareHandler } from "hono";
import { ROLES, type Role } from "./jwt.ts";

export type { Role } from "./jwt.ts";

export interface AuthUser { sub: string; email: string | null; role: Role }
export type AuthEnv = { Variables: { user: AuthUser; jwtPayload: unknown } };

export function userFromClaims(payload: unknown): AuthUser | null {
  const p = payload as { sub?: unknown; email?: unknown; app_metadata?: { role?: unknown } } | null;
  if (!p || typeof p.sub !== "string" || !p.sub) return null;
  const role = p.app_metadata?.role;
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) return null;
  return { sub: p.sub, email: typeof p.email === "string" ? p.email.trim().toLowerCase() : null, role: role as Role };
}

export function attachUser(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = userFromClaims(c.get("jwtPayload"));
    if (!user) return c.json({ error: "forbidden" }, 403);
    c.set("user", user);
    await next();
  };
}

export function requireRole(...roles: Role[]): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    // Sin attachUser previo no hay usuario: se falla cerrado con 403, no con un TypeError (500).
    const user = c.get("user") as AuthUser | undefined;
    if (!user || !roles.includes(user.role)) return c.json({ error: "forbidden" }, 403);
    await next();
  };
}
