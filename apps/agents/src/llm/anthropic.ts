import Anthropic from "@anthropic-ai/sdk";
import { validate } from "@jorgepirelarivas/clark";
import { MODELS, type Llm, type LlmFailure } from "./types.ts";

type MessagesClient = Pick<Anthropic, "messages">;

function textOf(res: Anthropic.Message): string {
  return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
}

function refusal(res: Anthropic.Message): LlmFailure | null {
  if (res.stop_reason !== "refusal") return null;
  return { ok: false, reason: "refusal", detail: (res.stop_details?.explanation ?? "").slice(0, 200) };
}

function truncated(res: Anthropic.Message): LlmFailure | null {
  if (res.stop_reason !== "max_tokens") return null;
  return { ok: false, reason: "invalid_output", detail: "truncado" };
}

// Un fallo del LLM nunca se propaga al canal: todo error se traduce a api_error (sin cuerpos ni claves).
function apiFailure(err: unknown): LlmFailure {
  if (err instanceof Anthropic.APIError) {
    return { ok: false, reason: "api_error", detail: `${err.status ?? "sin-status"} ${err.name}` };
  }
  return { ok: false, reason: "api_error", detail: err instanceof Error ? err.name : "unknown" };
}

export function createAnthropicLlm(client: MessagesClient): Llm {
  return {
    async classify<T>(req: Parameters<Llm["classify"]>[0]) {
      try {
        const res = await client.messages.create({
          model: MODELS.classify,
          max_tokens: 2048,
          system: req.system,
          messages: [{ role: "user", content: req.input }],
          output_config: { format: { type: "json_schema", schema: req.jsonSchema } },
        });
        const refused = refusal(res) ?? truncated(res);
        if (refused) return refused;
        let parsed: unknown;
        try { parsed = JSON.parse(textOf(res)); } catch {
          return { ok: false, reason: "invalid_output", detail: "JSON no parseable" } as const;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { ok: false, reason: "invalid_output", detail: "no es un objeto" } as const;
        }
        const check = validate(req.fields, parsed as Record<string, unknown>);
        if (!check.ok) {
          return { ok: false, reason: "invalid_output", detail: check.issues.map((i) => `${i.field}:${i.code}`).join(", ") } as const;
        }
        return { ok: true, value: parsed as T } as const;
      } catch (err) {
        return apiFailure(err);
      }
    },
    async converse(req) {
      try {
        const res = await client.messages.create({
          model: MODELS.converse,
          max_tokens: 1024,
          system: req.system,
          messages: req.messages,
        });
        const refused = refusal(res) ?? truncated(res);
        if (refused) return refused;
        const text = textOf(res);
        if (!text) return { ok: false, reason: "invalid_output", detail: "respuesta vacía" };
        return { ok: true, value: text };
      } catch (err) {
        return apiFailure(err);
      }
    },
  };
}
