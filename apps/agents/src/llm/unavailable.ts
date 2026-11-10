import type { Llm } from "./types.ts";

// Sin ANTHROPIC_API_KEY (solo desarrollo): el agente responde con FALLBACK_REPLY y marca el caso para humano.
export function createUnavailableLlm(): Llm {
  const failure = { ok: false, reason: "api_error", detail: "sin ANTHROPIC_API_KEY" } as const;
  return { async classify() { return failure; }, async converse() { return failure; } };
}
