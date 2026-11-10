// preDeploy de Render (P14). Usar la conexión directa/sesión (5432), no el pooler transaccional.
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL_DIRECT?.trim() || process.env.DATABASE_URL?.trim();
if (!url) { console.error("migrate: falta DATABASE_URL_DIRECT o DATABASE_URL"); process.exit(1); }
const client = postgres(url, { max: 1, prepare: false });
try {
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)) });
  console.log("migrate: ok");
} finally {
  await client.end();
}
