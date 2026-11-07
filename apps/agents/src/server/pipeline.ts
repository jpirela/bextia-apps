import type { Db } from "../db/index.ts";
import { kpi_event } from "../db/schema.ts";
import type { InboundMessage } from "../channels/types.ts";
import { InvalidPayloadError } from "../channels/errors.ts";
import { ingest, type IngestResult } from "../gateway/ingest.ts";
import { route, type RouteDecision } from "../orchestrator/route.ts";
import type { RateLimiter } from "./rate-limit.ts";

export type Dispatch = (ctx: { msg: InboundMessage; ingest: IngestResult; decision: RouteDecision }) => Promise<void>;

export interface PipelineDeps {
  db: Db;
  defaultMarket: string;
  contactLimiter: RateLimiter;
  dispatch?: Dispatch; // Agente 1 / Agente 2 (subproyectos 2 y 3)
}

export interface InboundOutcome {
  status: "duplicate" | "rate_limited" | "routed";
  conversationId: string;
  decision?: RouteDecision;
}

const SIN_CONTACTO = "Mensaje sin identificador de contacto";

export function createPipeline(deps: PipelineDeps): (msg: InboundMessage) => Promise<InboundOutcome> {
  return async (msg) => {
    let ing: IngestResult;
    try {
      ing = await ingest(deps.db, msg);
    } catch (err) {
      // Sin teléfono ni email no hay a quién asociar el mensaje: es un error del remitente (400), no del servidor.
      if (err instanceof Error && err.message === SIN_CONTACTO) throw new InvalidPayloadError(SIN_CONTACTO);
      throw err;
    }
    if (ing.duplicate) return { status: "duplicate", conversationId: ing.conversationId };
    if (!deps.contactLimiter.hit(ing.contact.id)) return { status: "rate_limited", conversationId: ing.conversationId };
    const decision = await route(deps.db, { contact: ing.contact, at: msg.receivedAt, defaultMarket: deps.defaultMarket });
    await deps.db.insert(kpi_event).values({
      tipo: "mensaje_recibido", agente: decision.agent, canal: msg.channel, ref_id: ing.conversationId,
      datos: { withinHours: decision.withinHours, market: decision.market },
    });
    await deps.dispatch?.({ msg, ingest: ing, decision });
    return { status: "routed", conversationId: ing.conversationId, decision };
  };
}
