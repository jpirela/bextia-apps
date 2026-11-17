import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { validate, type FieldDescriptor } from "@jorgepirelarivas/clark";
import type { PgTable } from "drizzle-orm/pg-core";
import { business_hours, kb_article, on_call, protocol, sales_agent } from "../db/schema.ts";
import { parseWeeklyHours, assertTimeZone } from "../orchestrator/business-hours.ts";
import { embedPendingArticles } from "../rag/kb.ts";
import { requireRole, type AuthEnv } from "../auth/roles.ts";
import { invalid, notFound, readJson, UUID_RE, type Issue } from "./http.ts";
import type { ApiDeps } from "./index.ts";

interface ResourceDef {
  table: PgTable & { id: never; activo?: never };
  fields: FieldDescriptor[];
  softDelete?: boolean;
  /** Columnas que admiten null; el resto de campos rechaza null (NOT NULL). */
  nullable?: string[];
  /** Exige zona_horaria cuando hay horario (se contrasta con la fila guardada en PATCH). */
  needsZone?: boolean;
  normalize?: (v: Record<string, unknown>) => Record<string, unknown>;
  check?: (v: Record<string, unknown>) => Issue[];
  after?: (deps: ApiDeps) => Promise<void>;
}

const tz = (v: Record<string, unknown>): Issue[] => {
  if (v.zona_horaria == null) return [];
  try { assertTimeZone(String(v.zona_horaria)); return []; } catch { return [{ field: "zona_horaria", code: "timezone", message: "zona horaria IANA inválida" }]; }
};
// Validación compartida de horario semanal y festivos (business_hours y sales_agent).
const hoursIssues = (v: Record<string, unknown>): Issue[] => {
  const issues: Issue[] = [];
  if (v.horario !== undefined && v.horario !== null) {
    try {
      const w = parseWeeklyHours(v.horario);
      if (!Object.values(w).some((r) => r && r.length > 0)) issues.push({ field: "horario", code: "hours", message: "al menos un día con tramos" });
    } catch { issues.push({ field: "horario", code: "hours", message: "horario inválido (HH:MM)" }); }
  }
  if (Array.isArray(v.festivos) && v.festivos.some((d) => typeof d !== "string" || !isRealDate(d))) issues.push({ field: "festivos", code: "date", message: "fechas YYYY-MM-DD" });
  return issues;
};
const lowerEmail = (v: Record<string, unknown>) => (typeof v.email === "string" ? { ...v, email: v.email.trim().toLowerCase() } : v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Fecha real: round-trip por Date (rechaza 2026-13-45 y 2026-02-30).
const isRealDate = (d: string) => {
  if (!DATE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const trimKeys = (keys: string[]) => (v: Record<string, unknown>) => {
  const o = { ...v };
  for (const k of keys) if (typeof o[k] === "string") o[k] = (o[k] as string).trim();
  return o;
};
const compose = (...fs: Array<(v: Record<string, unknown>) => Record<string, unknown>>) => (v: Record<string, unknown>) => fs.reduce((a, f) => f(a), v);
const MAX_NUMERIC = 9999999999.99; // numeric(12,2)
const uniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505";

const RESOURCES: Record<string, ResourceDef> = {
  sales_agent: {
    table: sales_agent as never, softDelete: true, needsZone: true, nullable: ["zona_horaria", "horario"], normalize: compose(lowerEmail, trimKeys(["nombre"])), check: (v) => [...tz(v), ...hoursIssues(v)],
    fields: [
      { name: "nombre", type: "text", required: true, min: 1, max: 120 },
      { name: "email", type: "email", required: true },
      { name: "destinos", type: "array", item: { name: "", type: "text" } },
      { name: "idiomas", type: "array", item: { name: "", type: "text" } },
      { name: "mercados", type: "array", item: { name: "", type: "text" } },
      { name: "tipos_lead", type: "array", item: { name: "", type: "text" } },
      { name: "zona_horaria", type: "text" },
      { name: "horario", type: "object" }, // claves mon…sun; null = jornada por omisión
      { name: "festivos", type: "array", item: { name: "", type: "text" } },
      { name: "activo", type: "boolean" },
    ] as FieldDescriptor[],
  },
  business_hours: {
    table: business_hours as never,
    fields: [
      { name: "mercado", type: "text", required: true, min: 2, max: 10 },
      { name: "zona_horaria", type: "text", required: true },
      { name: "horario", type: "object", required: true }, // claves mon…sun; rangos [["HH:MM","HH:MM"]]
      { name: "festivos", type: "array", item: { name: "", type: "text" } },
    ] as FieldDescriptor[],
    check: (v) => [...tz(v), ...hoursIssues(v)],
  },
  on_call: {
    table: on_call as never, softDelete: true, nullable: ["telefono"], normalize: compose(lowerEmail, trimKeys(["nombre"])),
    fields: [
      { name: "nombre", type: "text", required: true, min: 1 },
      { name: "email", type: "email", required: true },
      { name: "telefono", type: "text", pattern: "^\\+[1-9]\\d{6,14}$" },
      { name: "prioridad", type: "integer", min: 1, max: 99 },
      { name: "activo", type: "boolean" },
    ] as FieldDescriptor[],
  },
  kb_article: {
    table: kb_article as never,
    normalize: (v) => ({ ...trimKeys(["titulo"])(v), embedding: null }), // todo cambio invalida el embedding
    fields: [
      { name: "titulo", type: "text", required: true, min: 1, max: 200 },
      { name: "contenido", type: "longtext", required: true, min: 1, max: 20000 },
      { name: "idioma", type: "enum", enum: ["es", "en", "pt", "fr", "it", "de"] },
      { name: "etiquetas", type: "array", item: { name: "", type: "text" } },
    ] as FieldDescriptor[],
    after: async (deps) => { if (deps.embedder) await embedPendingArticles(deps.db, deps.embedder); },
  },
};

function check(def: ResourceDef, body: Record<string, unknown>, partial: boolean, stored?: Record<string, unknown>): Issue[] {
  const nulls = Object.keys(body).filter((k) => body[k] === null && !(def.nullable ?? []).includes(k))
    .map((k) => ({ field: k, code: "null", message: "no admite null" }));
  const eff = { ...(stored ?? {}), ...body };
  const zone: Issue[] = def.needsZone && eff.horario != null && eff.zona_horaria == null
    ? [{ field: "zona_horaria", code: "required", message: "obligatoria si hay horario" }] : [];
  const allowed = new Set(def.fields.map((f) => f.name));
  const extra = Object.keys(body).filter((k) => !allowed.has(k)).map((k) => ({ field: k, code: "unknown", message: "campo no permitido" }));
  const fields = partial ? def.fields.filter((f) => f.name in body).map((f) => ({ ...f, required: false })) : def.fields;
  const res = validate(fields as FieldDescriptor[], body, { locale: "es" });
  return [...nulls, ...extra, ...zone, ...(res.ok ? [] : res.issues), ...(def.check?.(body) ?? [])];
}

export function configRoutes(deps: ApiDeps): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
  r.use("*", requireRole("admin"));

  // protocolo: lectura y dos campos editables.
  r.get("/protocol", async (c) => c.json({ data: await deps.db.select().from(protocol).orderBy(asc(protocol.codigo), asc(protocol.version)) }));
  r.patch("/protocol/:id", async (c) => {
    const pid = c.req.param("id");
    if (!UUID_RE.test(pid)) return notFound(c);
    const body = await readJson(c);
    if (!body) return invalid(c, [{ field: "", code: "json", message: "cuerpo inválido" }]);
    if (!Object.keys(body).length) return invalid(c, [{ field: "", code: "empty", message: "nada para actualizar" }]);
    const extra = Object.keys(body).filter((k) => k !== "tope_autorizado" && k !== "activo");
    if (extra.length) return invalid(c, extra.map((k) => ({ field: k, code: "unknown", message: "campo no editable" })));
    const set: Partial<typeof protocol.$inferInsert> = {};
    if ("tope_autorizado" in body) {
      const t = body.tope_autorizado;
      if (t !== null && (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > MAX_NUMERIC)) return invalid(c, [{ field: "tope_autorizado", code: "min", message: "número entre 0 y 9999999999.99" }]);
      set.tope_autorizado = t === null ? null : (t as number).toFixed(2);
    }
    if ("activo" in body) {
      if (typeof body.activo !== "boolean") return invalid(c, [{ field: "activo", code: "bool", message: "true o false" }]);
      set.activo = body.activo;
    }
    const [row] = await deps.db.update(protocol).set(set).where(eq(protocol.id, pid)).returning();
    return row ? c.json(row) : notFound(c);
  });
  r.all("/protocol", (c) => notFound(c));

  r.use("/:recurso/*", async (c, next) => (RESOURCES[c.req.param("recurso")] ? next() : notFound(c)));
  r.use("/:recurso", async (c, next) => (RESOURCES[c.req.param("recurso")] ? next() : notFound(c)));

  r.get("/:recurso", async (c) => {
    const def = RESOURCES[c.req.param("recurso")];
    const rows = await deps.db.select().from(def.table as PgTable);
    // El embedding no viaja al panel.
    return c.json({ data: rows.map(({ embedding: _e, ...x }: Record<string, unknown>) => x) });
  });

  r.post("/:recurso", async (c) => {
    const def = RESOURCES[c.req.param("recurso")];
    const body = await readJson(c);
    if (!body) return invalid(c, [{ field: "", code: "json", message: "cuerpo inválido" }]);
    const v = def.normalize ? def.normalize(body) : body;
    const issues = check(def, Object.fromEntries(Object.entries(v).filter(([k]) => k !== "embedding")), false);
    if (issues.length) return invalid(c, issues);
    let row: Record<string, unknown>;
    let status: 201 | 200 = 201;
    try { [row] = await deps.db.insert(def.table as PgTable).values(v as never).returning() as Record<string, unknown>[]; } catch (e) {
      if (!uniqueViolation(e)) throw e;
      // Baja lógica: un alta con el email de una fila inactiva la reactiva con los datos nuevos; si está activa, 409.
      const t = def.table as never as PgTable & { email: never; activo: never };
      const [back] = def.softDelete && typeof v.email === "string"
        ? await deps.db.update(t).set({ ...v, activo: true } as never).where(and(eq(t.email, v.email as never), eq(t.activo, false as never))).returning() as Record<string, unknown>[]
        : [];
      if (!back) return c.json({ error: "conflict" }, 409);
      row = back; status = 200;
    }
    // Si falla el embedder la fila ya está guardada: queda pendiente y la reindexa el siguiente guardado.
    try { await def.after?.(deps); } catch (e) { console.error("kb: embedding pendiente", (e as Error).name); }
    const { embedding: _e, ...out } = row;
    return c.json(out, status);
  });

  r.patch("/:recurso/:id", async (c) => {
    const def = RESOURCES[c.req.param("recurso")];
    const rid = c.req.param("id");
    if (!UUID_RE.test(rid)) return notFound(c);
    const body = await readJson(c);
    if (!body || !Object.keys(body).length) return invalid(c, [{ field: "", code: "empty", message: "nada para actualizar" }]);
    const v = def.normalize ? def.normalize(body) : body;
    const t = def.table as PgTable & { id: never };
    const idCol = (t as never as { id: never }).id;
    let stored: Record<string, unknown> | undefined;
    if (def.needsZone && ("horario" in v || "zona_horaria" in v)) {
      [stored] = await deps.db.select().from(t as PgTable).where(eq(idCol, rid as never)) as Record<string, unknown>[];
      if (!stored) return notFound(c);
    }
    const issues = check(def, Object.fromEntries(Object.entries(v).filter(([k]) => k !== "embedding")), true, stored);
    if (issues.length) return invalid(c, issues);
    let row: Record<string, unknown> | undefined;
    try { [row] = await deps.db.update(t).set(v as never).where(eq(idCol, rid as never)).returning() as Record<string, unknown>[]; } catch (e) {
      if (uniqueViolation(e)) return c.json({ error: "conflict" }, 409);
      throw e;
    }
    if (!row) return notFound(c);
    try { await def.after?.(deps); } catch (e) { console.error("kb: embedding pendiente", (e as Error).name); }
    const { embedding: _e, ...out } = row;
    return c.json(out);
  });

  r.delete("/:recurso/:id", async (c) => {
    const def = RESOURCES[c.req.param("recurso")];
    const rid = c.req.param("id");
    if (!UUID_RE.test(rid)) return notFound(c);
    const t = def.table as never as PgTable & { id: never };
    const where = eq((t as never as { id: never }).id, rid as never);
    const rows = def.softDelete
      ? await deps.db.update(t).set({ activo: false } as never).where(where).returning()
      : await deps.db.delete(t).where(where).returning();
    return rows.length ? c.json({ ok: true }) : notFound(c);
  });

  return r;
}
