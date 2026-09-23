import type { StoreLike } from '../log.ts';
import { formatScope, type Subscription } from './subscription.ts';
import { Watcher, type WatchHost, type WatchOptions } from './watcher.ts';

export type WatchesHost = {
  store: StoreLike;
  // the store key the subscriptions persist under
  key: string;
  // the store key a repository's poll state persists under, one per session and repository
  stateKey: (repo: string) => string;
  now: () => number;
  log: (text: string) => void;
  status: (text: string | undefined) => void;
  // what every poller shares; the registry supplies the per-repository rest
  watcher: Omit<WatchHost, 'key' | 'subscriptions' | 'retire' | 'prepare' | 'rate' | 'status'>;
  options: Omit<WatchOptions, 'repo'>;
};

type Stored = { next: number; subs: Subscription[] };

// the subscriptions of a session and one poller per repository they name: a poller starts with the first
// subscription on its repository and stops with the last
export class Watches {
  private subs: Subscription[] = [];
  private next = 1;
  private readonly pollers = new Map<string, Watcher>();
  private readonly statuses = new Map<string, string>();
  private readonly rate = { until: 0 };

  constructor(private readonly host: WatchesHost) {}

  // restores the session's subscriptions and starts a poller for each repository they name
  async load(): Promise<void> {
    const stored = (await this.host.store.get(this.host.key)) as Stored | undefined;
    this.subs = stored?.subs ?? [];
    this.next = stored?.next ?? 1;
    for (const repo of this.repos()) await this.ensure(repo);
  }

  list(): Subscription[] {
    return [...this.subs];
  }

  on(repo: string): Subscription[] {
    return this.subs.filter((s) => s.repo === repo);
  }

  repos(): string[] {
    return [...new Set(this.subs.map((s) => s.repo))];
  }

  poller(repo: string): Watcher | undefined {
    return this.pollers.get(repo);
  }

  // an identical subscription (repository, scope, filter, owner, until) is the same one and keeps its id
  async subscribe(input: Omit<Subscription, 'id'>): Promise<{ sub: Subscription; added: boolean }> {
    const same = this.subs.find((s) => s.repo === input.repo && formatScope(s.scope) === formatScope(input.scope) && JSON.stringify(s.filter) === JSON.stringify(input.filter) && s.for === input.for && s.until === input.until);
    if (same) return { sub: same, added: false };
    const sub: Subscription = { id: `s${this.next++}`, ...input };
    this.subs.push(sub);
    await this.save();
    const existing = this.pollers.get(sub.repo);
    const poller = await this.ensure(sub.repo);
    if (sub.scope.kind === 'run') {
      await poller.await(sub.scope.id);
      if (existing) void poller.tick();
    }
    return { sub, added: true };
  }

  async unsubscribe(id: string): Promise<boolean> {
    if (!this.subs.some((s) => s.id === id)) return false;
    await this.remove([id], 'unsubscribed');
    return true;
  }

  async remove(ids: string[], why: string): Promise<void> {
    const gone = this.subs.filter((s) => ids.includes(s.id));
    if (gone.length === 0) return;
    this.subs = this.subs.filter((s) => !ids.includes(s.id));
    await this.save();
    for (const s of gone) this.host.log(`sift watch: ${s.id} on ${s.repo} ${formatScope(s.scope)} removed, ${why}`);
    for (const repo of new Set(gone.map((s) => s.repo))) {
      if (this.on(repo).length > 0) continue;
      this.pollers.get(repo)?.stop();
      this.pollers.delete(repo);
      this.statuses.delete(repo);
      this.showStatus();
    }
  }

  // every subscription an agent owns, once nothing can reach it any more
  async retireOwner(agentId: string, why: string): Promise<void> {
    await this.remove(this.subs.filter((s) => s.for === agentId).map((s) => s.id), why);
  }

  // a subscription whose until time has passed. an owner that finished its turn keeps its subscriptions: a delivery
  // resumes it
  async reap(): Promise<void> {
    const now = this.host.now();
    const expired = this.subs.filter((s) => s.until !== undefined && !['settled', 'merged', 'closed'].includes(s.until) && Date.parse(s.until) <= now).map((s) => s.id);
    if (expired.length > 0) await this.remove(expired, 'until reached');
  }

  stop(): void {
    for (const p of this.pollers.values()) p.stop();
  }

  private async ensure(repo: string): Promise<Watcher> {
    const have = this.pollers.get(repo);
    if (have) return have;
    const poller = new Watcher(
      {
        ...this.host.watcher,
        key: this.host.stateKey(repo),
        subscriptions: () => this.on(repo),
        retire: (ids, why) => this.remove(ids, why),
        prepare: () => this.reap(),
        rate: this.rate,
        status: (text) => {
          if (text === undefined) this.statuses.delete(repo);
          else this.statuses.set(repo, text);
          this.showStatus();
        },
      },
      { ...this.host.options, repo },
    );
    this.pollers.set(repo, poller);
    await poller.start();
    return poller;
  }

  private showStatus(): void {
    this.host.status(this.statuses.size > 0 ? [...this.statuses.values()].join('; ') : undefined);
  }

  private async save(): Promise<void> {
    await this.host.store.set(this.host.key, { next: this.next, subs: this.subs } satisfies Stored);
  }
}
