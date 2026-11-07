import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

// Común a postgres-js (prod) y PGlite (tests): ambos extienden PgDatabase.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

export function createDb(url: string): Db {
  // prepare:false — requerido por el pooler de Supabase en modo transacción.
  const client = postgres(url, { prepare: false });
  return drizzle({ client, schema }) as unknown as Db;
}
