// Supabase Edge Function: embeddings gte-small (384 dims, normalizados).
// Despliegue (con aprobación): supabase functions deploy embed --no-verify-jwt ; supabase secrets set EMBED_SECRET=...
// Autenticación por secreto compartido en x-embed-secret (las claves sb_secret no son JWT).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const session = new Supabase.ai.Session("gte-small");
const MAX_INPUTS = 32;
const MAX_CHARS = 8000;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const secret = Deno.env.get("EMBED_SECRET") ?? "";
  if (!secret || !safeEqual(req.headers.get("x-embed-secret") ?? "", secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
  const input = body?.input;
  const texts = Array.isArray(input) ? input : typeof input === "string" ? [input] : null;
  if (!texts || texts.length === 0 || texts.length > MAX_INPUTS
    || texts.some((t) => typeof t !== "string" || t.length === 0 || t.length > MAX_CHARS)) {
    return Response.json({ error: "invalid_input" }, { status: 400 });
  }
  const embeddings: number[][] = [];
  for (const text of texts as string[]) {
    const out = await session.run(text, { mean_pool: true, normalize: true });
    embeddings.push(Array.from(out as ArrayLike<number>));
  }
  return Response.json({ embeddings });
});
