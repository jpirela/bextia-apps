// Uso: DATABASE_URL=... yarn workspace @bextia/agents protocol:seed 40 EUR
// Contra Supabase solo con aprobación explícita del usuario.
import { createDb } from "../db/index.ts";
import { seedProtocol } from "./seed.ts";

const [tope, moneda] = process.argv.slice(2);
const url = process.env.DATABASE_URL?.trim();
if (!url || !tope || !moneda) {
  console.error("uso: DATABASE_URL=... yarn workspace @bextia/agents protocol:seed <tope> <moneda>");
  process.exit(1);
}
const r = await seedProtocol(createDb(url), { tope: Number(tope), moneda });
console.log(`protocolo traslado_no_presentado v${r.version} activo`);
process.exit(0);
