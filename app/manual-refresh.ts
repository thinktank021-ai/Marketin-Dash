type RefreshTask = { label: string; phase: number; run: () => Promise<unknown> };

/** Mounted views register their real loaders, not a remount or a decorative counter. */
export class ManualRefreshController {
  private tasks = new Set<RefreshTask>();
  private pending: Promise<string[]> | null = null;
  signal: AbortSignal | undefined;
  private warnings = new Set<string>();
  warn(message: string) { this.warnings.add(message); }
  get active() { return this.pending !== null; }
  register(label: string, run: () => Promise<unknown>, phase = 1) {
    const task = { label, run, phase }; this.tasks.add(task);
    return () => { this.tasks.delete(task); };
  }
  run() {
    if (this.pending) return this.pending;
    const abort = new AbortController(); this.signal = abort.signal;
    this.warnings.clear();
    const deadline = setTimeout(() => abort.abort(), 45000);
    this.pending = Promise.resolve().then(async () => {
      const failures: string[] = [];
      for (const phase of [0, 1, 2]) {
        const tasks = [...this.tasks].filter(task => task.phase === phase);
        await Promise.all(tasks.map(async task => {
          try {
            if (abort.signal.aborted) throw new Error("مهلت بروزرسانی تمام شد؛ دوباره تلاش کنید.");
            await Promise.race([task.run(), new Promise((_, reject) => {
              abort.signal.addEventListener("abort", () => reject(new Error("مهلت بروزرسانی تمام شد؛ دادهٔ قبلی حفظ شد.")), { once: true });
            })]);
          } catch (error) { failures.push(`${task.label}: ${error instanceof Error ? error.message : "دریافت ناموفق"}`); }
        }));
        // Allow React to commit new data and register the next phase's current loaders.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return [...new Set([...failures, ...this.warnings])];
    }).finally(() => { clearTimeout(deadline); this.pending = null; this.signal = undefined; });
    return this.pending;
  }
}

/** A manual click during polling queues a real second read instead of being ignored. */
export class RefreshGate {
  private pending: Promise<void> | null = null;
  async run(task: () => Promise<void>, force = false): Promise<void> {
    if (this.pending) {
      try { await this.pending; } catch { /* A manual retry must still run after failure. */ }
      if (!force) return;
    }
    const pending = task(); this.pending = pending;
    try { await pending; } finally { if (this.pending === pending) this.pending = null; }
  }
}
export const manualRefresh = new ManualRefreshController();
