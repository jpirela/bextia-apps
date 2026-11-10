import { afterEach, describe, expect, it, vi } from "vitest";
import { startInterval } from "./scheduler.ts";

afterEach(() => vi.useRealTimers());

describe("startInterval", () => {
  it("no solapa ejecuciones y registra errores sin detenerse", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let running = 0; let max = 0; let calls = 0;
    const stop = startInterval(async () => {
      calls++; running++; max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 250));
      running--;
      if (calls === 1) throw new TypeError("boom");
    }, 100, "test");
    await vi.advanceTimersByTimeAsync(1_000);
    stop();
    expect(max).toBe(1);
    expect(calls).toBeGreaterThan(1);
    expect(err).toHaveBeenCalledWith("scheduler test: error", "TypeError");
  });
});
