import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

const raw = readFileSync(fileURLToPath(new URL("../../../../supabase/rls/0001_rls.sql", import.meta.url)), "utf8");
// Se evalúa el SQL sin comentarios: los comentarios no deben poder pasar ni romper el test.
const sql = raw.replace(/--[^\n]*/g, "");
const statements = sql.split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
const policies = statements.filter((s) => /^CREATE POLICY\b/i.test(s));
const tables = Object.values(schema).filter((v) => is(v, PgTable)).map((t) => getTableConfig(t as PgTable).name);

const ROLE = "(select auth.jwt()) -> 'app_metadata' ->> 'role'";
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe("RLS", () => {
  it("cada tabla del esquema tiene RLS activado", () => {
    expect(tables.length).toBeGreaterThan(10);
    for (const t of tables) expect(sql, t).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
  });

  it("ninguna política para anon y nada de escritura para authenticated", () => {
    expect(sql).not.toMatch(/TO\s+anon/i);
    expect(sql).not.toMatch(/FOR\s+(INSERT|UPDATE|DELETE|ALL)/i);
    // Sin FOR vale FOR ALL y sin TO vale TO public (incluye anon): cada política debe declarar ambos.
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      expect(p, p).toMatch(/^CREATE POLICY \w+ ON public\.\w+ FOR SELECT TO authenticated USING \(/i);
    }
  });

  it("el rol sale de app_metadata en cada política que lo usa, nunca de user_metadata", () => {
    expect(sql).not.toContain("user_metadata");
    const conRol = policies.filter((p) => p.includes("'role'"));
    expect(conRol.map((p) => p.split(" ")[2]).sort()).toEqual(["incident_select_por_rol", "lead_select_por_rol"]);
    for (const p of conRol) expect(count(p, "'role'"), p).toBe(count(p, ROLE));
  });

  it("auth.jwt() siempre envuelto en (select ...) y índice sobre lower(email)", () => {
    expect(count(sql, "auth.jwt()")).toBeGreaterThan(0);
    expect(count(sql, "auth.jwt()")).toBe(count(sql, "(select auth.jwt())"));
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS sales_agent_email_lower ON public.sales_agent (lower(email));");
  });

  it("es idempotente: cada CREATE POLICY va precedido de su DROP POLICY IF EXISTS", () => {
    for (const p of policies) {
      const [, name, table] = p.match(/^CREATE POLICY (\w+) ON (public\.\w+)/i)!;
      const drop = statements.indexOf(`DROP POLICY IF EXISTS ${name} ON ${table}`);
      expect(drop, name).toBeGreaterThanOrEqual(0);
      expect(drop, name).toBeLessThan(statements.indexOf(p));
    }
  });
});
