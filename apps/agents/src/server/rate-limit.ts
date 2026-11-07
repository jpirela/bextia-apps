export interface RateLimiter { hit(key: string): boolean }

// Ventana fija en memoria: válido para una sola instancia (ver docs/deuda-tecnica.md).
export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key) {
      const t = now();
      if (buckets.size > 10_000) {
        for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
      }
      const b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + opts.windowMs });
        return true;
      }
      b.count += 1;
      return b.count <= opts.limit;
    },
  };
}
