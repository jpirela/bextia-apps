import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { kb_article } from "../db/schema.ts";
import type { Embedder } from "./embedder.ts";

export interface KbHit { id: string; titulo: string; contenido: string; similarity: number }
export interface KnowledgeBase { search(query: string, opts?: { k?: number; idioma?: string | null }): Promise<KbHit[]> }

const toVectorLiteral = (vec: number[]) => `[${vec.join(",")}]`;

export function buildSearchQuery(db: Db, vec: number[], opts: { k: number; idioma?: string | null }) {
  const literal = toVectorLiteral(vec);
  const distance = sql`${kb_article.embedding} <=> ${literal}::vector`;
  const where = opts.idioma
    ? and(isNotNull(kb_article.embedding), eq(kb_article.idioma, opts.idioma))
    : isNotNull(kb_article.embedding);
  return db.select({
    id: kb_article.id,
    titulo: kb_article.titulo,
    contenido: kb_article.contenido,
    similarity: sql<number>`1 - (${distance})`.mapWith(Number),
  }).from(kb_article).where(where).orderBy(distance).limit(opts.k);
}

// P6: sin test local (PGlite no trae pgvector); validar contra Supabase.
export function createPgvectorKb(db: Db, embedder: Embedder, opts: { minSimilarity?: number } = {}): KnowledgeBase {
  const min = opts.minSimilarity ?? 0.78;
  return {
    async search(query, o = {}) {
      const [vec] = await embedder.embed([query]);
      const rows = await buildSearchQuery(db, vec, { k: o.k ?? 3, idioma: o.idioma });
      return rows.filter((r) => r.similarity >= min);
    },
  };
}

export function createStaticKb(hits: KbHit[]): KnowledgeBase {
  return { async search(_q, o = {}) { return hits.slice(0, o.k ?? 3); } };
}

// Indexa artículos sin embedding. Devuelve cuántos actualizó.
export async function embedPendingArticles(db: Db, embedder: Embedder, batch = 16): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await db.select({ id: kb_article.id, titulo: kb_article.titulo, contenido: kb_article.contenido })
      .from(kb_article).where(isNull(kb_article.embedding)).limit(batch);
    if (rows.length === 0) return total;
    const vecs = await embedder.embed(rows.map((r) => `${r.titulo}\n${r.contenido}`.slice(0, 8000)));
    for (let i = 0; i < rows.length; i++) {
      await db.update(kb_article).set({ embedding: vecs[i] }).where(eq(kb_article.id, rows[i].id));
    }
    total += rows.length;
  }
}
