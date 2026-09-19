import type { Decision } from './judge/index.ts';

export type StoreLike = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
};

const KEY = 'decisions';
const MAX = 500;

export type Stats = {
  calls: number;
  failures: number;
  byModule: Record<string, { calls: number; acted: number; shadow: number; latencyMs: number }>;
};

// a bounded ring of decisions in the plugin store, the source of the /sift report
export class DecisionLog {
  private pending: Decision[] = [];
  private flushing?: Promise<void>;
  constructor(private readonly store: StoreLike) {}

  push(decision: Decision): void {
    this.pending.push(decision);
    void this.flush();
  }

  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        while (this.pending.length > 0) {
          const batch = this.pending.splice(0);
          const current = ((await this.store.get(KEY)) as Decision[] | undefined) ?? [];
          await this.store.set(KEY, [...current, ...batch].slice(-MAX));
        }
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  // readers see every decision pushed before the call
  async recent(limit = 50): Promise<Decision[]> {
    await this.flush();
    const all = ((await this.store.get(KEY)) as Decision[] | undefined) ?? [];
    return all.slice(-limit);
  }

  async stats(): Promise<Stats> {
    await this.flush();
    const all = ((await this.store.get(KEY)) as Decision[] | undefined) ?? [];
    const stats: Stats = { calls: 0, failures: 0, byModule: {} };
    for (const d of all) {
      stats.calls += 1;
      if (!d.ok) stats.failures += 1;
      const m = (stats.byModule[d.module] ??= { calls: 0, acted: 0, shadow: 0, latencyMs: 0 });
      m.calls += 1;
      if (d.shadow) m.shadow += 1;
      else if (d.action !== 'none' && d.action !== 'fallback') m.acted += 1;
      m.latencyMs += d.latencyMs ?? 0;
    }
    return stats;
  }

  async clear(): Promise<void> {
    await this.store.set(KEY, []);
  }
}
