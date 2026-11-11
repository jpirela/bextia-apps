import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

const sql = readFileSync(fileURLToPath(new URL("../../../../supabase/rls/0001_rls.sql", import.meta.url)), "utf8");
const tables = Object.values(schema).filter((v) => is(v, PgTable)).map((t) => getTableConfig(t as PgTable).name);

describe("RLS", () => {
  it("cada tabla del esquema tiene RLS activado", () => {
    expect(tables.length).toBeGreaterThan(10);
    for (const t of tables) expect(sql, t).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
  });
  it("ninguna política para anon y nada de escritura para authenticated", () => {
    expect(sql).not.toMatch(/TO\s+anon/i);
    expect(sql).not.toMatch(/FOR\s+(INSERT|UPDATE|DELETE|ALL)/i);
  });
  it("el rol sale de app_metadata, nunca de user_metadata", () => {
    expect(sql).toContain("auth.jwt() -> 'app_metadata' ->> 'role'");
    expect(sql).not.toContain("user_metadata");
  });
  it("es idempotente: cada CREATE POLICY va precedido de su DROP POLICY IF EXISTS", () => {
    const creates = [...sql.matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+(public\.\w+)/g)];
    expect(creates.length).toBeGreaterThan(0);
    for (const [, name, table] of creates) {
      const drop = sql.indexOf(`DROP POLICY IF EXISTS ${name} ON ${table};`);
      expect(drop, name).toBeGreaterThanOrEqual(0);
      expect(drop, name).toBeLessThan(sql.indexOf(`CREATE POLICY ${name} ON ${table}`));
    }
  });
});
