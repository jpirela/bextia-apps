import type { Context } from "hono";

export type Issue = { field: string; code: string; message: string };

export const invalid = (c: Context, issues: Issue[]) => c.json({ error: "invalid", issues }, 400);
export const notFound = (c: Context) => c.json({ error: "not_found" }, 404);

export async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

// YYYY-MM-DD o ISO 8601; null si falta o es inválida.
export function dateParam(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
