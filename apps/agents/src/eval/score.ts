import { classifyIncident } from "../incidents/classify.ts";
import { parseProviderReply } from "../incidents/provider.ts";
import { extractQualification } from "../leads/qualify.ts";
import type { Llm } from "../llm/types.ts";
import type { EvalCase } from "./cases.ts";

export type EvalResult = {
  id: string;
  prompt: EvalCase["prompt"];
  ok: boolean;
  expected: EvalCase["expected"];
  got: Record<string, unknown> | null;
  mismatches: string[];
};

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

export function matches(expected: EvalCase["expected"], got: Record<string, unknown> | null): string[] {
  return Object.entries(expected).flatMap(([k, want]) => {
    const v = got?.[k];
    if (got === null) return [k];
    if (want === null) return v === null || v === undefined || v === "" ? [] : [k];
    if (typeof want === "string") return typeof v === "string" && norm(v).includes(norm(want)) ? [] : [k];
    return v === want ? [] : [k];
  });
}

async function call(llm: Llm, c: EvalCase, today: string): Promise<Record<string, unknown> | null> {
  if (c.prompt === "cualificacion") {
    const r = await extractQualification(llm, c.turns, today);
    return r.ok ? { ...r.value } : null;
  }
  if (c.prompt === "incidencia") {
    const r = await classifyIncident(llm, c.turns);
    return r ? { ...r } : null;
  }
  const text = c.turns.map((t) => t.contenido).join("\n");
  return { ...(await parseProviderReply(llm, text)) };
}

export async function runCase(llm: Llm, c: EvalCase, today: string): Promise<EvalResult> {
  const got = await call(llm, c, today);
  const mismatches = matches(c.expected, got);
  return { id: c.id, prompt: c.prompt, ok: mismatches.length === 0, expected: c.expected, got, mismatches };
}
