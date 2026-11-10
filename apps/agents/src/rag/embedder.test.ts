import { describe, expect, it, vi } from "vitest";
import { createFakeEmbedder, createSupabaseEmbedder, EMBEDDING_DIMS, EmbedderError } from "./embedder.ts";

const vec = (v: number) => Array.from({ length: EMBEDDING_DIMS }, () => v);

describe("createSupabaseEmbedder", () => {
  it("llama a la función embed con el secreto y devuelve los vectores", async () => {
    const fetchMock = vi.fn(async () => Response.json({ embeddings: [vec(0.1), vec(0.2)] }));
    const e = createSupabaseEmbedder({ url: "https://abc.supabase.co/", secret: "s3", fetch: fetchMock as unknown as typeof fetch });
    const out = await e.embed(["hola", "adiós"]);
    expect(out).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://abc.supabase.co/functions/v1/embed");
    expect((init.headers as Record<string, string>)["x-embed-secret"]).toBe("s3");
    expect(JSON.parse(init.body as string)).toEqual({ input: ["hola", "adiós"] });
  });
  it("lanza EmbedderError ante HTTP no-2xx sin incluir el cuerpo", async () => {
    const e = createSupabaseEmbedder({ url: "https://x", secret: "s", fetch: (async () => new Response("secreto", { status: 500 })) as unknown as typeof fetch });
    await expect(e.embed(["a"])).rejects.toThrow(new EmbedderError("embed: HTTP 500"));
  });
  it("lanza EmbedderError si la dimensión no es 384", async () => {
    const e = createSupabaseEmbedder({ url: "https://x", secret: "s", fetch: (async () => Response.json({ embeddings: [[1, 2]] })) as unknown as typeof fetch });
    await expect(e.embed(["a"])).rejects.toThrow(EmbedderError);
  });
  it("no llama a la red con lista vacía", async () => {
    const fetchMock = vi.fn();
    const e = createSupabaseEmbedder({ url: "https://x", secret: "s", fetch: fetchMock as unknown as typeof fetch });
    expect(await e.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createFakeEmbedder", () => {
  it("es determinista, de 384 dims y normalizado", async () => {
    const e = createFakeEmbedder();
    const [a, b] = await e.embed(["equipaje permitido", "equipaje permitido"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIMS);
    expect(Math.hypot(...a)).toBeCloseTo(1, 5);
  });
});
