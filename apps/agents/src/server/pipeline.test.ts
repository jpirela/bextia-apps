import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import { kpi_event } from "../db/schema.ts";
import type { Db } from "../db/index.ts";
import type { InboundMessage } from "../channels/types.ts";
import { InvalidPayloadError } from "../channels/errors.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { createPipeline } from "./pipeline.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const msg = (externalId: string): InboundMessage => ({
  channel: "sim", externalId, from: { email: "ana@example.com" }, text: "Quiero ir a Japón",
  receivedAt: new Date("2026-11-09T22:00:00Z"),
});

describe("pipeline", () => {
  it("rutea, registra kpi y llama a dispatch una sola vez por mensaje", async () => {
    const dispatch = vi.fn(async () => {});
    const run = createPipeline({ db, defaultMarket: "ES", contactLimiter: createRateLimiter({ limit: 10, windowMs: 60_000 }), dispatch });
    const first = await run(msg("m-1"));
    const dup = await run(msg("m-1"));
    expect(first.status).toBe("routed");
    expect(first.decision?.agent).toBe("leads");
    expect(dup.status).toBe("duplicate");
    expect(dispatch).toHaveBeenCalledTimes(1);
    const events = await db.select().from(kpi_event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tipo: "mensaje_recibido", agente: "leads", canal: "sim" });
  });

  it("corta por límite de mensajes por contacto, pero guarda el mensaje", async () => {
    const run = createPipeline({ db, defaultMarket: "ES", contactLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) });
    await run(msg("m-1"));
    expect((await run(msg("m-2"))).status).toBe("rate_limited");
  });

  it("un mensaje sin teléfono ni email se rechaza como payload inválido (400), no como error interno", async () => {
    const run = createPipeline({ db, defaultMarket: "ES", contactLimiter: createRateLimiter({ limit: 10, windowMs: 60_000 }) });
    const sinContacto: InboundMessage = { ...msg("m-x"), from: {} };
    await expect(run(sinContacto)).rejects.toBeInstanceOf(InvalidPayloadError);
  });
});
