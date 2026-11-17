import { Hono, type Context } from "hono";
import { eq, sql } from "drizzle-orm";
import { validate, type FieldDescriptor } from "@jorgepirelarivas/clark";
import type { Db } from "../db/index.ts";
import { booking, contact, type BookingService } from "../db/schema.ts";
import { requireRole, type AuthEnv } from "../auth/roles.ts";
import { CsvError, parseCsv } from "./csv.ts";
import { invalid } from "./http.ts";
import type { ApiDeps } from "./index.ts";

export const REQUIRED_COLUMNS = ["codigo", "viajero_nombre", "viajero_telefono", "viajero_email", "destino", "inicio", "fin"] as const;
export const OPTIONAL_COLUMNS = ["traslado_proveedor", "traslado_telefono", "traslado_email", "traslado_inicio", "traslado_lugar", "traslado_referencia"] as const;
export const MAX_ROWS = 5000;
export const MAX_BYTES = 2 * 1024 * 1024;

export type ImportResult = { creadas: number; actualizadas: number; errores: { fila: number; field: string; message: string }[] };

const E164 = "^\\+[1-9]\\d{6,14}$";
const ISO = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$";
const FIELDS = [
  { name: "codigo", type: "text", required: true, min: 1, max: 64 },
  { name: "viajero_nombre", type: "text", required: true, min: 1, max: 200 },
  { name: "viajero_telefono", type: "text", pattern: E164 },
  { name: "viajero_email", type: "email" },
  { name: "destino", type: "text", required: true, min: 1 },
  { name: "inicio", type: "text", required: true, pattern: ISO },
  { name: "fin", type: "text", required: true, pattern: ISO },
  { name: "traslado_telefono", type: "text", pattern: E164 },
  { name: "traslado_email", type: "email" },
  { name: "traslado_inicio", type: "text", pattern: ISO },
] as FieldDescriptor[];

// Vacíos → ausentes: Clark no debe validar patrones sobre "".
const compact = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ""));

export async function importBookings(db: Db, rows: Record<string, string>[], _now: Date = new Date()): Promise<ImportResult> {
  const out: ImportResult = { creadas: 0, actualizadas: 0, errores: [] };
  for (const [i, raw] of rows.entries()) {
    const fila = i + 2; // la cabecera es la fila 1
    const r = compact(raw) as Record<string, string>;
    const res = validate(FIELDS, r, { locale: "es" });
    const issues = res.ok ? [] : res.issues.map((x) => ({ field: x.field, message: x.message }));
    if (!r.viajero_telefono && !r.viajero_email) issues.push({ field: "viajero_telefono", message: "teléfono o email obligatorio" });
    if (r.inicio && r.fin && new Date(r.fin) < new Date(r.inicio)) issues.push({ field: "fin", message: "fin anterior a inicio" });
    if (issues.length) { out.errores.push(...issues.map((x) => ({ fila, ...x }))); continue; }

    const email = r.viajero_email?.trim().toLowerCase() ?? null; // P27: email normalizado (trim + minúsculas)
    const telefono = r.viajero_telefono ?? null;
    let [ct] = telefono ? await db.select().from(contact).where(eq(contact.telefono, telefono)) : [];
    if (!ct && email) [ct] = await db.select().from(contact).where(sql`lower(trim(${contact.email})) = ${email}`);
    if (!ct) [ct] = await db.insert(contact).values({ nombre: r.viajero_nombre, telefono, email }).returning();
    else if (ct.email && ct.email !== ct.email.trim().toLowerCase()) {
      // P27: un contacto previo con email sin normalizar se corrige al encontrarlo.
      await db.update(contact).set({ email: ct.email.trim().toLowerCase() }).where(eq(contact.id, ct.id));
    }

    // BookingService del schema real (sp3): telefono/email planos, sin `contacto` anidado; opcionales ausentes.
    const servicios: BookingService[] = r.traslado_proveedor ? [{
      tipo: "traslado", proveedor: r.traslado_proveedor,
      ...(r.traslado_telefono ? { telefono: r.traslado_telefono } : {}),
      ...(r.traslado_email ? { email: r.traslado_email.toLowerCase() } : {}),
      ...(r.traslado_inicio ? { inicio: new Date(r.traslado_inicio).toISOString() } : {}),
      ...(r.traslado_lugar ? { lugar: r.traslado_lugar } : {}),
      ...(r.traslado_referencia ? { referencia: r.traslado_referencia } : {}),
    }] : [];
    const values = {
      codigo: r.codigo, contact_id: ct.id, viajero_nombre: r.viajero_nombre, viajero_telefono: telefono, viajero_email: email,
      destino: r.destino, inicio: new Date(r.inicio), fin: new Date(r.fin), servicios,
    };
    const [prev] = await db.select({ id: booking.id }).from(booking).where(eq(booking.codigo, r.codigo));
    if (prev) { await db.update(booking).set(values).where(eq(booking.id, prev.id)); out.actualizadas++; }
    else { await db.insert(booking).values(values); out.creadas++; }
  }
  return out;
}

export class ImportFormatError extends Error {
  constructor(message: string) { super(message); this.name = "ImportFormatError"; }
}

export function rowsFromCsv(text: string): Record<string, string>[] {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new ImportFormatError("archivo mayor a 2 MB");
  let table: string[][];
  try { table = parseCsv(text); } catch (e) { if (e instanceof CsvError) throw new ImportFormatError(e.message); throw e; }
  const [header, ...body] = table;
  const cols = (header ?? []).map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
  if (missing.length) throw new ImportFormatError(`faltan columnas: ${missing.join(", ")}`);
  if (body.length > MAX_ROWS) throw new ImportFormatError(`máximo ${MAX_ROWS} filas`);
  return body.map((cells) => Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""])));
}

export async function rowsFromRequest(c: Context): Promise<Record<string, string>[]> {
  const type = c.req.header("content-type") ?? "";
  if (type.startsWith("text/csv")) return rowsFromCsv(await c.req.text());
  const body = await c.req.json().catch(() => null) as { rows?: unknown } | null;
  if (!body || !Array.isArray(body.rows)) throw new ImportFormatError("se espera text/csv o { rows: [...] }");
  if (body.rows.length > MAX_ROWS) throw new ImportFormatError(`máximo ${MAX_ROWS} filas`);
  return body.rows.map((r) => Object.fromEntries(Object.entries((r ?? {}) as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v == null ? "" : String(v)])));
}

export async function handleImport(c: Context, db: Db, read: () => Promise<Record<string, string>[]>) {
  try {
    return c.json(await importBookings(db, await read()));
  } catch (e) {
    if (e instanceof ImportFormatError) return invalid(c, [{ field: "archivo", code: "format", message: e.message }]);
    throw e;
  }
}

export function importRoutes(deps: ApiDeps): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
  r.post("/bookings", requireRole("admin"), (c) => handleImport(c, deps.db, () => rowsFromRequest(c)));
  return r;
}
