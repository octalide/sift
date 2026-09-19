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
  byModule: Record<string, { calls: number; acted: number; shadow: number; latencyMs: number; requestTokens: number; responseTokens: number; tokensRemoved: number }>;
  // this session alone; the ring holds every session that ran the plugin
  session: { calls: number; failures: number; lastFailure?: Decision; cost: Cost };
  cost: Cost;
};

// judge tokens spent against context tokens taken out
export type Cost = { requestTokens: number; responseTokens: number; tokensRemoved: number };

// a bounded ring of decisions in the plugin store, the source of the /sift report
export class DecisionLog {
  private pending: Decision[] = [];
  private flushing?: Promise<void>;
  private unreported: Decision[] = [];
  constructor(
    private readonly store: StoreLike,
    private readonly session?: string,
  ) {}

  push(decision: Decision): void {
    const stamped = decision.session === undefined && this.session !== undefined ? { ...decision, session: this.session } : decision;
    if (!stamped.ok) this.unreported.push(stamped);
    this.pending.push(stamped);
    void this.flush();
  }

  // failures since the last time this was called, one line per module, for a warning at the next prompt
  takeWarnings(): string[] {
    const bursts = new Map<string, Decision[]>();
    for (const d of this.unreported) bursts.set(d.module, [...(bursts.get(d.module) ?? []), d]);
    this.unreported = [];
    return [...bursts.entries()].map(([module, ds]) => {
      const last = ds[ds.length - 1]!;
      return `sift ${module} fell back ${ds.length === 1 ? 'once' : `${ds.length} times`} since the last prompt (${last.backend}: ${last.reason ?? 'no reason'}), the built-in behaviour ran instead`;
    });
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
    const zero = (): Cost => ({ requestTokens: 0, responseTokens: 0, tokensRemoved: 0 });
    const add = (c: Cost, d: Decision) => {
      c.requestTokens += d.requestTokens ?? 0;
      c.responseTokens += d.responseTokens ?? 0;
      if (!d.shadow) c.tokensRemoved += d.tokensRemoved ?? 0;
    };
    const stats: Stats = { calls: 0, failures: 0, byModule: {}, session: { calls: 0, failures: 0, cost: zero() }, cost: zero() };
    for (const d of all) {
      stats.calls += 1;
      if (!d.ok) stats.failures += 1;
      add(stats.cost, d);
      if (this.session !== undefined && d.session === this.session) {
        stats.session.calls += 1;
        add(stats.session.cost, d);
        if (!d.ok) {
          stats.session.failures += 1;
          stats.session.lastFailure = d;
        }
      }
      const m = (stats.byModule[d.module] ??= { calls: 0, acted: 0, shadow: 0, latencyMs: 0, requestTokens: 0, responseTokens: 0, tokensRemoved: 0 });
      m.calls += 1;
      if (d.shadow) m.shadow += 1;
      else if (d.action !== 'none' && d.action !== 'fallback') m.acted += 1;
      m.latencyMs += d.latencyMs ?? 0;
      add(m, d);
    }
    return stats;
  }

  async clear(): Promise<void> {
    await this.store.set(KEY, []);
  }
}
