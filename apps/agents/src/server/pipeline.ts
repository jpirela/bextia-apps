import type { Db } from "../db/index.ts";
import { kpi_event } from "../db/schema.ts";
import type { InboundMessage } from "../channels/types.ts";
import { ingest, type IngestResult } from "../gateway/ingest.ts";
import { route, type RouteDecision } from "../orchestrator/route.ts";
import type { RateLimiter } from "./rate-limit.ts";

export type Dispatch = (ctx: { msg: InboundMessage; ingest: IngestResult; decision: RouteDecision }) => Promise<void>;

export interface PipelineDeps {
  db: Db;
  defaultMarket: string;
  contactLimiter: RateLimiter;
  dispatch?: Dispatch; // Agente 1 / Agente 2 (subproyectos 2 y 3)
  background?: boolean; // true en producción: el webhook responde sin esperar al LLM (P5)
}

export interface InboundOutcome {
  status: "duplicate" | "rate_limited" | "routed";
  conversationId: string;
  decision?: RouteDecision;
}

export function createPipeline(deps: PipelineDeps): (msg: InboundMessage) => Promise<InboundOutcome> {
  // Un dispatch a la vez por conversación (instancia única, ver P17): el siguiente mensaje del mismo
  // cliente espera al anterior y ve su respuesta en el historial, en vez de correr en paralelo.
  const queues = new Map<string, Promise<void>>();
  const serialized = (conversationId: string, run: () => Promise<void>): Promise<void> => {
    const start = (): Promise<void> => { try { return Promise.resolve(run()); } catch (err) { return Promise.reject(err); } };
    const prev = queues.get(conversationId);
    const p = prev ? prev.then(start, start) : start();
    const tail = p.catch(() => {});
    queues.set(conversationId, tail);
    void tail.then(() => { if (queues.get(conversationId) === tail) queues.delete(conversationId); });
    return p;
  };

  return async (msg) => {
    const ing = await ingest(deps.db, msg);
    if (ing.duplicate) return { status: "duplicate", conversationId: ing.conversationId };
    if (!deps.contactLimiter.hit(ing.contact.id)) return { status: "rate_limited", conversationId: ing.conversationId };
    const decision = await route(deps.db, { contact: ing.contact, at: msg.receivedAt, defaultMarket: deps.defaultMarket });
    await deps.db.insert(kpi_event).values({
      tipo: "mensaje_recibido", agente: decision.agent, canal: msg.channel, ref_id: ing.conversationId,
      datos: { withinHours: decision.withinHours, market: decision.market },
    });
    const ctx = { msg, ingest: ing, decision };
    const dispatch = deps.dispatch;
    if (dispatch) {
      const p = serialized(ing.conversationId, () => dispatch(ctx));
      if (deps.background) {
        // Se pierde si el proceso cae a mitad (instancia única): ver P5 en docs/deuda-tecnica.md.
        void p.catch((err) => console.error("dispatch en segundo plano falló", (err as Error).name));
      } else {
        await p;
      }
    }
    return { status: "routed", conversationId: ing.conversationId, decision };
  };
}
