export const EMBEDDING_DIMS = 384; // gte-small

export interface Embedder { embed(texts: string[]): Promise<number[][]> }

export class EmbedderError extends Error {
  constructor(message: string) { super(message); this.name = "EmbedderError"; }
}

export function createSupabaseEmbedder(cfg: { url: string; secret: string; fetch?: typeof fetch }): Embedder {
  const doFetch = cfg.fetch ?? fetch;
  const endpoint = `${cfg.url.replace(/\/+$/, "")}/functions/v1/embed`;
  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      const res = await doFetch(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", "x-embed-secret": cfg.secret },
        body: JSON.stringify({ input: texts }),
      });
      if (!res.ok) throw new EmbedderError(`embed: HTTP ${res.status}`);
      const data = (await res.json().catch(() => null)) as { embeddings?: unknown } | null;
      const out = data?.embeddings;
      if (!Array.isArray(out) || out.length !== texts.length
        || out.some((v) => !Array.isArray(v) || v.length !== EMBEDDING_DIMS || v.some((n) => typeof n !== "number"))) {
        throw new EmbedderError("embed: respuesta inválida");
      }
      return out as number[][];
    },
  };
}

// Determinista y sin red: bolsa de palabras con hash a 384 cubetas, normalizada. Solo tests y simulador.
export function createFakeEmbedder(): Embedder {
  return {
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(EMBEDDING_DIMS).fill(0);
        for (const w of t.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").split(/\W+/).filter(Boolean)) {
          let h = 2166136261;
          for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
          v[(h >>> 0) % EMBEDDING_DIMS] += 1;
        }
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}
