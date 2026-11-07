import Anthropic from "@anthropic-ai/sdk";
import type { FieldDescriptor } from "@jorgepirelarivas/clark";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicLlm } from "./anthropic.ts";
import { MODELS } from "./types.ts";

function reply(text: string, stop_reason = "end_turn"): Anthropic.Message {
  return {
    id: "msg_1", type: "message", role: "assistant", model: "x", stop_reason, stop_sequence: null,
    content: [{ type: "text", text, citations: null }],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

function fakeClient(impl: (params?: unknown) => Promise<Anthropic.Message>) {
  const create = vi.fn(impl);
  return { client: { messages: { create } } as unknown as Pick<Anthropic, "messages">, create };
}

const fields = [
  { name: "intent", type: "enum", enum: ["lead", "incidencia"], required: true },
  { name: "urgencia", type: "integer", min: 0, max: 3, required: true },
] as FieldDescriptor[];
const jsonSchema = {
  type: "object", additionalProperties: false, required: ["intent", "urgencia"],
  properties: { intent: { type: "string", enum: ["lead", "incidencia"] }, urgencia: { type: "integer" } },
};
const req = { system: "Clasifica.", input: "Mi traslado no llegó", jsonSchema, fields };

describe("createAnthropicLlm.classify", () => {
  it("usa Haiku con salida json_schema y devuelve el JSON validado", async () => {
    const { client, create } = fakeClient(async () => reply('{"intent":"incidencia","urgencia":3}'));
    const r = await createAnthropicLlm(client).classify<{ intent: string; urgencia: number }>(req);
    expect(r).toEqual({ ok: true, value: { intent: "incidencia", urgencia: 3 } });
    const params = create.mock.calls[0][0] as Record<string, unknown>;
    expect(params.model).toBe(MODELS.classify);
    expect(params.output_config).toEqual({ format: { type: "json_schema", schema: jsonSchema } });
  });

  it("marca invalid_output si Clark rechaza la salida", async () => {
    const { client } = fakeClient(async () => reply('{"intent":"otra","urgencia":9}'));
    const r = await createAnthropicLlm(client).classify(req);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("invalid_output");
  });

  it("marca refusal", async () => {
    const { client } = fakeClient(async () => reply("", "refusal"));
    const r = await createAnthropicLlm(client).classify(req);
    expect(r.ok === false && r.reason).toBe("refusal");
  });

  it("convierte errores de la API en api_error sin lanzar", async () => {
    const { client } = fakeClient(async () => { throw new Anthropic.APIConnectionError({ message: "timeout" }); });
    const r = await createAnthropicLlm(client).classify(req);
    expect(r.ok === false && r.reason).toBe("api_error");
  });
});

describe("createAnthropicLlm.converse", () => {
  it("usa Sonnet y devuelve el texto", async () => {
    const { client, create } = fakeClient(async () => reply("¡Hola! ¿A qué destino te gustaría viajar?"));
    const r = await createAnthropicLlm(client).converse({ system: "Eres un agente.", messages: [{ role: "user", content: "Hola" }] });
    expect(r).toEqual({ ok: true, value: "¡Hola! ¿A qué destino te gustaría viajar?" });
    expect((create.mock.calls[0][0] as Record<string, unknown>).model).toBe(MODELS.converse);
  });

  it("texto vacío es invalid_output", async () => {
    const { client } = fakeClient(async () => reply("   "));
    const r = await createAnthropicLlm(client).converse({ system: "s", messages: [{ role: "user", content: "x" }] });
    expect(r.ok === false && r.reason).toBe("invalid_output");
  });
});
