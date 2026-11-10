export function startInterval(fn: () => Promise<unknown>, ms: number, name: string): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (err) { console.error(`scheduler ${name}: error`, (err as Error).name); } finally { running = false; }
  }, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}
