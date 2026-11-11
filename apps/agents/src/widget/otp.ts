import { createHmac, randomInt } from "node:crypto";
import { and, count, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { web_otp } from "../db/schema.ts";
import { safeEqual } from "../channels/errors.ts";

const TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_PER_WINDOW = 3;

export function normalizeDestino(raw: string): { kind: "email" | "phone"; value: string } | null {
  const s = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { kind: "email", value: s.toLowerCase() };
  const digits = s.replace(/[\s\-()]/g, "");
  if (/^\+?\d{7,15}$/.test(digits)) return { kind: "phone", value: `+${digits.replace(/^\+/, "")}` };
  return null;
}

function hash(secret: string, destino: string, codigo: string): string {
  return createHmac("sha256", secret).update(`${destino}:${codigo}`).digest("hex");
}

export async function issueOtp(
  db: Db, secret: string, destino: string,
  opts: { now?: Date; random?: () => string } = {},
): Promise<string | null> {
  const now = opts.now ?? new Date();
  const codigo = opts.random ? opts.random() : String(randomInt(0, 1_000_000)).padStart(6, "0");
  // El lock por destino serializa emisiones paralelas: count + insert no se pisan.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${destino}))`);
    const [{ n }] = await tx.select({ n: count() }).from(web_otp)
      .where(and(eq(web_otp.destino, destino), gt(web_otp.created_at, new Date(now.getTime() - TTL_MS))));
    if (n >= MAX_PER_WINDOW) return null;
    await tx.update(web_otp).set({ usado_at: now }).where(and(eq(web_otp.destino, destino), isNull(web_otp.usado_at)));
    await tx.insert(web_otp).values({
      destino, codigo_hash: hash(secret, destino, codigo), expira_at: new Date(now.getTime() + TTL_MS), created_at: now,
    });
    return codigo;
  });
}

export async function verifyOtp(db: Db, secret: string, destino: string, codigo: string, now = new Date()): Promise<boolean> {
  const [cur] = await db.select().from(web_otp)
    .where(and(eq(web_otp.destino, destino), isNull(web_otp.usado_at), gt(web_otp.expira_at, now)))
    .orderBy(desc(web_otp.created_at)).limit(1);
  if (!cur) return false;
  // Se reserva el intento ANTES de comparar: el límite es atómico frente a peticiones paralelas.
  const [row] = await db.update(web_otp).set({ intentos: sql`${web_otp.intentos} + 1` })
    .where(and(eq(web_otp.id, cur.id), isNull(web_otp.usado_at), lt(web_otp.intentos, MAX_ATTEMPTS))).returning();
  if (!row) return false;
  if (!safeEqual(row.codigo_hash, hash(secret, destino, codigo))) return false;
  const used = await db.update(web_otp).set({ usado_at: now })
    .where(and(eq(web_otp.id, row.id), isNull(web_otp.usado_at))).returning({ id: web_otp.id });
  return used.length === 1;
}