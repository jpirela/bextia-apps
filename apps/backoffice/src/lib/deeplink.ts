// src/lib/deeplink.ts
// Enlaces de los emails de los agentes: /leads/:id y /incidencias/:id (sin router).
export type DeepLink = { page: "leads" | "incidents"; id: string };

const ROUTES: { prefix: string; page: DeepLink["page"] }[] = [
  { prefix: "leads", page: "leads" },
  { prefix: "incidencias", page: "incidents" },
];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseDeepLink(pathname: string): DeepLink | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const route = ROUTES.find((r) => r.prefix === parts[0]);
  let id: string;
  try { id = decodeURIComponent(parts[1]); } catch { return null; }
  return route && ID_RE.test(id) ? { page: route.page, id } : null;
}
