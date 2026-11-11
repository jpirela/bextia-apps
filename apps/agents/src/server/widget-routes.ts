import type { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { contact, conversation, message } from "../db/schema.ts";
import { issueOtp, normalizeDestino, verifyOtp } from "../widget/otp.ts";
import { signWidgetToken, verifyWidgetToken } from "../widget/token.ts";

export interface WidgetDeps {
  db: Db;
  tokenSecret: string;
  deliverOtp: (d: { kind: "email" | "phone"; value: string }, codigo: string) => Promise<void>;
  tokenTtlMs?: number;
  now?: () => Date;
}

export function registerWidgetRoutes(app: Hono, deps: WidgetDeps): void {
  const now = deps.now ?? (() => new Date());
  const ttl = deps.tokenTtlMs ?? 12 * 60 * 60_000;
  const destinoOf = async (c: { req: { json: () => Promise<unknown> } }) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const d = typeof body?.destino === "string" ? normalizeDestino(body.destino) : null;
    return { body, d };
  };

  // Siempre 202: no revela si el destino existe, si se superó el límite ni si falló el envío.
  app.post("/widget/otp", async (c) => {
    const { d } = await destinoOf(c);
    if (!d) return c.json({ error: "invalid_destino" }, 400);
    const codigo = await issueOtp(deps.db, deps.tokenSecret, d.value, { now: now() });
    if (codigo) {
      try { await deps.deliverOtp(d, codigo); } catch (err) { console.error("widget: envío de OTP fallido", (err as Error).name); }
    }
    return c.json({ sent: true }, 202);
  });

  app.post("/widget/token", async (c) => {
    const { body, d } = await destinoOf(c);
    const codigo = typeof body?.codigo === "string" ? body.codigo.trim() : "";
    if (!d || !/^\d{6}$/.test(codigo)) return c.json({ error: "invalid_code" }, 401);
    if (!(await verifyOtp(deps.db, deps.tokenSecret, d.value, codigo, now()))) return c.json({ error: "invalid_code" }, 401);
    const exp = now().getTime() + ttl;
    return c.json({ token: signWidgetToken(deps.tokenSecret, { sub: d.value, kind: d.kind, exp }), expiresAt: new Date(exp).toISOString() });
  });

  app.get("/widget/messages", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const claims = auth.startsWith("Bearer ") ? verifyWidgetToken(deps.tokenSecret, auth.slice(7), now().getTime()) : null;
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    const [ct] = await deps.db.select({ id: contact.id }).from(contact)
      .where(claims.kind === "email" ? eq(contact.email, claims.sub) : eq(contact.telefono, claims.sub)).limit(1);
    if (!ct) return c.json([]);
    const convs = await deps.db.select({ id: conversation.id }).from(conversation)
      .where(and(eq(conversation.contact_id, ct.id), eq(conversation.canal, "web")));
    if (convs.length === 0) return c.json([]);
    const rows = await deps.db.select({ direccion: message.direccion, contenido: message.contenido, created_at: message.created_at })
      .from(message).where(inArray(message.conversation_id, convs.map((x) => x.id)))
      .orderBy(desc(message.created_at)).limit(100);
    return c.json(rows.reverse());
  });
}
