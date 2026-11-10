// Postgres 23505 = unique_violation. Drizzle envuelve el error del driver en `cause`.
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 3; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
