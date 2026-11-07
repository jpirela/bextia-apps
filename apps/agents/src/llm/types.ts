import type Anthropic from "@anthropic-ai/sdk";
import type { FieldDescriptor } from "@jorgepirelarivas/clark";

export const MODELS = { classify: "claude-haiku-5-5", converse: "claude-sonnet-5-5" } as const;

export const FALLBACK_REPLY =
  "Gracias por escribirnos. Hemos recibido tu mensaje y una persona de nuestro equipo te responderá en breve.";

export type LlmFailure = { ok: false; reason: "refusal" | "invalid_output" | "api_error"; detail: string };
export type LlmResult<T> = { ok: true; value: T } | LlmFailure;

export interface ClassifyRequest {
  system: string;
  input: string;
  jsonSchema: Record<string, unknown>;
  fields: FieldDescriptor[]; // validación Clark de la salida
}

export interface ConverseRequest {
  system: string;
  messages: Anthropic.MessageParam[];
}

export interface Llm {
  classify<T>(req: ClassifyRequest): Promise<LlmResult<T>>;
  converse(req: ConverseRequest): Promise<LlmResult<string>>;
}
