import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.ts";
import type { Db } from "./index.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle/", import.meta.url));

// PGlite se usa sin pgvector (extensión separada, no aprobada). Las migraciones de producción
// quedan intactas; solo para la BD de tests se descarta CREATE EXTENSION vector y
// vector(N) se sustituye por real[].
function testStatements(): string[] {
  const journal = JSON.parse(readFileSync(`${migrationsFolder}meta/_journal.json`, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  return journal.entries.flatMap((e) =>
    readFileSync(`${migrationsFolder}${e.tag}.sql`, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s && !/^CREATE EXTENSION\b[^;]*\bvector\b/i.test(s))
      .map((s) => s.replace(/\bvector\(\d+\)/g, "real[]")),
  );
}

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  for (const stmt of testStatements()) await client.exec(stmt);
  const db = drizzle({ client, schema });
  return { db: db as unknown as Db, close: () => client.close() };
}
