import { mkdirSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicLlm } from "../llm/anthropic.ts";
import { MODELS } from "../llm/types.ts";
import { CASES } from "./cases.ts";
import { runCase, type EvalResult } from "./score.ts";

const TODAY = "2026-11-07";
const OUT = new URL("../../../../.tmp/eval.json", import.meta.url);

if (process.env.EVAL_CONFIRM !== "si") {
  console.error("La evaluación llama a Claude y tiene costo. Exportar EVAL_CONFIRM=si tras aprobarla.");
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Falta ANTHROPIC_API_KEY en el entorno.");
  process.exit(2);
}

// Mismos límites que main.ts: sin esperas de 10 min por omisión.
const llm = createAnthropicLlm(new Anthropic({ maxRetries: 2, timeout: 20_000 }));
const results: EvalResult[] = [];
for (const c of CASES) {
  const r = await runCase(llm, c, TODAY); // secuencial: sin ráfagas ni rate limit
  results.push(r);
  console.log(`${r.id} ${r.ok ? "OK" : "FALLA"}${r.mismatches.length ? " " + r.mismatches.join(",") : ""}`);
}
mkdirSync(new URL(".", OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ model: MODELS, date: new Date().toISOString(), results }, null, 2));
const ok = results.filter((r) => r.ok).length;
console.log(`eval: ${ok}/${results.length} OK → .tmp/eval.json`);
