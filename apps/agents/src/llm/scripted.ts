import type { ClassifyRequest, ConverseRequest, Llm, LlmResult } from "./types.ts";

// Respuestas grabadas, deterministas y sin costo, para tests de los agentes.
export function createScriptedLlm(script: {
  classify?: Array<LlmResult<unknown>>;
  converse?: Array<LlmResult<string>>;
}): Llm & { calls: { classify: ClassifyRequest[]; converse: ConverseRequest[] } } {
  const classifyQueue = [...(script.classify ?? [])];
  const converseQueue = [...(script.converse ?? [])];
  const calls = { classify: [] as ClassifyRequest[], converse: [] as ConverseRequest[] };
  return {
    calls,
    async classify<T>(req: ClassifyRequest) {
      calls.classify.push(req);
      const next = classifyQueue.shift();
      if (!next) throw new Error("scripted llm: sin respuestas de classify");
      return next as LlmResult<T>;
    },
    async converse(req) {
      calls.converse.push(req);
      const next = converseQueue.shift();
      if (!next) throw new Error("scripted llm: sin respuestas de converse");
      return next;
    },
  };
}
