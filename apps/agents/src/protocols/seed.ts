import { readFileSync } from "node:fs";
import { eq, max } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { protocol } from "../db/schema.ts";
import { parseProtocol } from "./parse.ts";

export function loadDefaultDefinition(): unknown {
  return JSON.parse(readFileSync(new URL("./definitions/traslado-no-presentado.json", import.meta.url), "utf8"));
}

// Inserta una versión nueva activa y desactiva las anteriores del mismo código.
export async function seedProtocol(db: Db, opts: { tope: number; moneda: string; def?: unknown }): Promise<{ id: string; version: number }> {
  if (!Number.isFinite(opts.tope) || opts.tope <= 0 || opts.tope > 10_000) throw new RangeError("tope: número > 0 y ≤ 10000");
  if (!/^[A-Z]{3}$/.test(opts.moneda)) throw new RangeError("moneda: código ISO 4217 (p. ej. EUR)");
  const raw = opts.def ?? loadDefaultDefinition();
  const def = parseProtocol(raw);
  return db.transaction(async (tx) => {
    const [{ v }] = await tx.select({ v: max(protocol.version) }).from(protocol).where(eq(protocol.codigo, def.codigo));
    const version = (v ?? 0) + 1;
    await tx.update(protocol).set({ activo: false }).where(eq(protocol.codigo, def.codigo));
    const [row] = await tx.insert(protocol).values({
      codigo: def.codigo, nombre: def.nombre, version, activo: true,
      definicion: raw as Record<string, unknown>, tope_autorizado: opts.tope.toFixed(2), moneda: opts.moneda,
    }).returning({ id: protocol.id });
    return { id: row.id, version };
  });
}
