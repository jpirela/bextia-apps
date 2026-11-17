import { Hono } from "hono";
import type { Db } from "../db/index.ts";
import type { AuthEnv } from "../auth/roles.ts";
import type { ChannelAdapter, InboundMessage, OutboundMessage } from "../channels/types.ts";
import type { InboundOutcome } from "../server/pipeline.ts";
import type { Embedder } from "../rag/embedder.ts";
import { simRoutes } from "./sim.ts";

export interface ApiDeps {
  db: Db;
  now?: () => Date;
  embedder?: Embedder | null;
  simulator?: { adapter: ChannelAdapter; outbox: OutboundMessage[] } | null;
  pipeline: (m: InboundMessage) => Promise<InboundOutcome>;
}

// Rutas autenticadas: el JWT y attachUser ya corrieron (ver createApp). Las tasks 3–9 agregan sub-apps aquí.
export function createApiRoutes(deps: ApiDeps): Hono<AuthEnv> {
  const api = new Hono<AuthEnv>();
  api.get("/me", (c) => c.json(c.get("user")));
  api.route("/sim", simRoutes(deps));
  return api;
}
