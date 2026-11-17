import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
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

// ISO 8601 con zona y fecha real: el round-trip por Date debe coincidir (rechaza 2026-02-30, mes 13, T25:00).
const ISO_RE = new RegExp(ISO);
export function validIso(s: string): boolean {
  if (!ISO_RE.test(s)) return false;
  const [y, mo, d] = [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))];
  const [h, mi] = [Number(s.slice(11, 13)), Number(s.slice(14, 16))];
  const sec = /^.{16}:(\d{2})/.exec(s)?.[1];
  const cal = new Date(Date.UTC(y, mo - 1, d));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return false;
  if (h > 23 || mi > 59 || (sec !== undefined && Number(sec) > 59)) return false;
  const off = /([+-])(\d{2}):(\d{2})$/.exec(s);
  if (off && (Number(off[2]) > 23 || Number(off[3]) > 59)) return false;
  return !Number.isNaN(new Date(s).getTime());
}

const pgCode = (e: unknown): string | undefined =>
  (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;

// `primeraFila`: número de la fila de datos 1 (2 en CSV por la cabecera; 1 en JSON).
export async function importBookings(db: Db, rows: Record<string, string>[], primeraFila = 2): Promise<ImportResult> {
  const out: ImportResult = { creadas: 0, actualizadas: 0, errores: [] };
  for (const [i, raw] of rows.entries()) {
    const fila = i + primeraFila;
    const r = compact(raw) as Record<string, string>;
    const res = validate(FIELDS, r, { locale: "es" });
    const issues = res.ok ? [] : res.issues.map((x) => ({ field: x.field, message: x.message }));
    if (!r.viajero_telefono && !r.viajero_email) issues.push({ field: "viajero_telefono", message: "teléfono o email obligatorio" });
    for (const f of ["inicio", "fin", "traslado_inicio"]) {
      if (r[f] && !issues.some((x) => x.field === f) && !validIso(r[f])) issues.push({ field: f, message: "fecha inválida" });
    }
    if (!issues.some((x) => x.field === "inicio" || x.field === "fin") && r.inicio && r.fin && new Date(r.fin) < new Date(r.inicio)) {
      issues.push({ field: "fin", message: "fin anterior a inicio" });
    }
    if (issues.length) { out.errores.push(...issues.map((x) => ({ fila, ...x }))); continue; }

    try {
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
    } catch (e) {
      // Un fallo de BD en una fila no tumba el lote. Sin message/params: llevan PII.
      const dup = pgCode(e) === "23505";
      console.error("import: fila rechazada", (e as Error).name, pgCode(e));
      out.errores.push({ fila, field: "fila", message: dup ? "conflicto con un registro existente (código, email o teléfono duplicado)" : "no se pudo guardar la fila" });
    }
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

// `primeraFila`: 2 en CSV (la cabecera es la fila 1); 1 en JSON (sin cabecera).
export type Parsed = { rows: Record<string, string>[]; primeraFila: number };

export const bodyTooLarge = (c: Context) => c.json({ error: "payload_too_large" }, 413);

export async function rowsFromRequest(c: Context): Promise<Parsed> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (type.startsWith("text/csv")) return { rows: rowsFromCsv(await c.req.text()), primeraFila: 2 };
  const body = await c.req.json().catch(() => null) as { rows?: unknown } | null;
  if (!body || !Array.isArray(body.rows)) throw new ImportFormatError("se espera text/csv o { rows: [...] }");
  if (body.rows.length > MAX_ROWS) throw new ImportFormatError(`máximo ${MAX_ROWS} filas`);
  const rows = body.rows.map((r) => Object.fromEntries(Object.entries((r ?? {}) as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v == null ? "" : String(v)])));
  return { rows, primeraFila: 1 };
}

// Adjuntos .csv de un correo: los topes de 2 MB y 5 000 filas cuentan por importación, no por adjunto.
export function rowsFromAttachments(body: unknown): Parsed {
  const att = (body as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(att)) throw new ImportFormatError("se espera { attachments: [...] }");
  const csvs = att.filter((a): a is { filename?: string; contentType?: string; contentBase64?: string } => !!a && typeof a === "object")
    .filter((a) => /\.csv$/i.test(a.filename ?? "") || (a.contentType ?? "").toLowerCase().startsWith("text/csv"));
  const rows: Record<string, string>[] = [];
  let bytes = 0;
  for (const a of csvs) {
    const buf = Buffer.from(typeof a.contentBase64 === "string" ? a.contentBase64 : "", "base64");
    bytes += buf.byteLength;
    if (bytes > MAX_BYTES) throw new ImportFormatError("los adjuntos suman más de 2 MB");
    rows.push(...rowsFromCsv(buf.toString("utf8")));
    if (rows.length > MAX_ROWS) throw new ImportFormatError(`máximo ${MAX_ROWS} filas`);
  }
  return { rows, primeraFila: 2 };
}

export async function handleImport(c: Context, db: Db, read: () => Promise<Parsed>) {
  try {
    const { rows, primeraFila } = await read();
    return c.json(await importBookings(db, rows, primeraFila));
  } catch (e) {
    if (e instanceof ImportFormatError) return invalid(c, [{ field: "archivo", code: "format", message: e.message }]);
    throw e;
  }
}

export function importRoutes(deps: ApiDeps): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
  r.post("/bookings", requireRole("admin"), bodyLimit({ maxSize: MAX_BYTES, onError: bodyTooLarge }), (c) => handleImport(c, deps.db, () => rowsFromRequest(c)));
  return r;
}
