import { Hono } from "hono";
import type { AuthEnv } from "../auth/roles.ts";
import { requireRole } from "../auth/roles.ts";
import type { ApiDeps } from "./index.ts";
import { processInbound } from "../server/app.ts";

// Ruling P12: el operador lee la bandeja; solo el admin inyecta mensajes.
export function simRoutes(deps: ApiDeps): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();
  const sim = deps.simulator;
  r.use("*", requireRole("admin", "operador"));
  r.use("*", async (c, next) => (sim ? next() : c.json({ error: "not_found" }, 404)));
  r.get("/outbox", (c) => c.json(sim!.outbox));
  r.post("/send", requireRole("admin"), async (c) => {
    const raw = new Request("http://sim.local/send", { method: "POST", headers: { "content-type": "application/json" }, body: await c.req.text() });
    return processInbound(c, sim!.adapter, raw, deps.pipeline);
  });
  return r;
}
