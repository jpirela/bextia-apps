import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { web_otp } from "../db/schema.ts";
import { issueOtp, normalizeDestino, verifyOtp } from "./otp.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const t0 = new Date("2026-11-08T10:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

describe("OTP del widget", () => {
  it("normaliza email y teléfono", () => {
    expect(normalizeDestino(" Ana@Example.com ")).toEqual({ kind: "email", value: "ana@example.com" });
    expect(normalizeDestino("+34 600-000-001")).toEqual({ kind: "phone", value: "+34600000001" });
    expect(normalizeDestino("hola")).toBeNull();
  });
  it("emite, verifica una sola vez y guarda solo el hash", async () => {
    const code = await issueOtp(db, "s", "ana@example.com", { now: t0, random: () => "123456" });
    expect(code).toBe("123456");
    const [row] = await db.select().from(web_otp);
    expect(row.codigo_hash).not.toContain("123456");
    expect(await verifyOtp(db, "s", "ana@example.com", "123456", at(1))).toBe(true);
    expect(await verifyOtp(db, "s", "ana@example.com", "123456", at(2))).toBe(false);
  });
  it("vence a los 10 minutos", async () => {
    await issueOtp(db, "s", "ana@example.com", { now: t0, random: () => "123456" });
    expect(await verifyOtp(db, "s", "ana@example.com", "123456", at(11))).toBe(false);
  });
  it("bloquea tras 5 intentos fallidos", async () => {
    await issueOtp(db, "s", "ana@example.com", { now: t0, random: () => "123456" });
    for (let i = 0; i < 5; i++) expect(await verifyOtp(db, "s", "ana@example.com", "000000", at(1))).toBe(false);
    expect(await verifyOtp(db, "s", "ana@example.com", "123456", at(1))).toBe(false);
  });
  it("un código nuevo invalida el anterior; máximo 3 cada 10 min", async () => {
    await issueOtp(db, "s", "ana@example.com", { now: t0, random: () => "111111" });
    await issueOtp(db, "s", "ana@example.com", { now: at(1), random: () => "222222" });
    expect(await verifyOtp(db, "s", "ana@example.com", "111111", at(2))).toBe(false);
    await issueOtp(db, "s", "ana@example.com", { now: at(2), random: () => "333333" });
    expect(await issueOtp(db, "s", "ana@example.com", { now: at(3), random: () => "444444" })).toBeNull();
    expect(await issueOtp(db, "s", "ana@example.com", { now: at(13), random: () => "555555" })).toBe("555555");
  });
  it("el límite de intentos es atómico frente a verificaciones paralelas", async () => {
    await issueOtp(db, "s", "ana@example.com", { now: t0, random: () => "123456" });
    const bad = await Promise.all(Array.from({ length: 10 }, () => verifyOtp(db, "s", "ana@example.com", "000000", at(1))));
    expect(bad.every((b) => b === false)).toBe(true);
    expect(await verifyOtp(db, "s", "ana@example.com", "123456", at(1))).toBe(false);
    const [row] = await db.select().from(web_otp);
    expect(row.intentos).toBe(5);
  });
  it("emisiones paralelas respetan el máximo de 3", async () => {
    const r = await Promise.all(Array.from({ length: 6 }, (_, i) => issueOtp(db, "s", "ana@example.com", { now: at(i * 0.01), random: () => String(100000 + i) })));
    expect(r.filter((c) => c !== null)).toHaveLength(3);
  });
});