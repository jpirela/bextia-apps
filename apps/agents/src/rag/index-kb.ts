// Uso (con aprobación, contra Supabase): yarn workspace @bextia/agents kb:index
import { createDb } from "../db/index.ts";
import { createSupabaseEmbedder } from "./embedder.ts";
import { embedPendingArticles } from "./kb.ts";

const { DATABASE_URL, SUPABASE_URL, EMBED_SECRET } = process.env;
if (!DATABASE_URL || !SUPABASE_URL || !EMBED_SECRET) {
  console.error("kb:index requiere DATABASE_URL, SUPABASE_URL y EMBED_SECRET");
  process.exit(1);
}
const n = await embedPendingArticles(createDb(DATABASE_URL), createSupabaseEmbedder({ url: SUPABASE_URL, secret: EMBED_SECRET }));
console.log(`kb:index: ${n} artículos indexados`);
process.exit(0);
