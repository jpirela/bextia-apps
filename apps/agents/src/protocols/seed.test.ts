import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { protocol } from "../db/schema.ts";
import { seedProtocol } from "./seed.ts";
import { InvalidProtocolError } from "./parse.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

describe("seedProtocol", () => {
  it("versiona y deja activa solo la última", async () => {
    expect(await seedProtocol(db, { tope: 40, moneda: "EUR" })).toMatchObject({ version: 1 });
    expect(await seedProtocol(db, { tope: 55.5, moneda: "EUR" })).toMatchObject({ version: 2 });
    const rows = await db.select().from(protocol).orderBy(asc(protocol.version));
    expect(rows.map((r) => [r.version, r.activo, r.tope_autorizado, r.moneda])).toEqual([[1, false, "40.00", "EUR"], [2, true, "55.50", "EUR"]]);
    expect(rows[1]).toMatchObject({ codigo: "traslado_no_presentado", nombre: "Traslado no presentado" });
  });
  it("rechaza tope, moneda o definición inválidos sin escribir", async () => {
    await expect(seedProtocol(db, { tope: 0, moneda: "EUR" })).rejects.toBeInstanceOf(RangeError);
    await expect(seedProtocol(db, { tope: 40, moneda: "euro" })).rejects.toBeInstanceOf(RangeError);
    await expect(seedProtocol(db, { tope: 40, moneda: "EUR", def: { codigo: "x" } })).rejects.toBeInstanceOf(InvalidProtocolError);
    expect(await db.select().from(protocol)).toHaveLength(0);
  });
});
