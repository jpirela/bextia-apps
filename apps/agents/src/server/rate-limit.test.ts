import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.ts";

describe("createRateLimiter", () => {
  it("permite hasta el límite por ventana y se reinicia", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    expect([rl.hit("a"), rl.hit("a"), rl.hit("a")]).toEqual([true, true, false]);
    expect(rl.hit("b")).toBe(true);
    t = 1000;
    expect(rl.hit("a")).toBe(true);
  });
});
