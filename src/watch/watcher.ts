import type { RepoConfig } from '../github/config.ts';
import { Gh, GhError } from '../github/gh.ts';
import type { Judge } from '../judge/types.ts';
import type { Pack } from '../packs/types.ts';
import type { StoreLike } from '../log.ts';
import { diffItems, diffRuns, formatEvent, initialState, toItem, toRuns, trimRuns, type Deferred, type WatchEvent, type WatchState } from './poll.ts';
import { eventSubject, judgeEvent, routeByRules, type EventDetail, type WatchRules } from './triage.ts';

export type WatchOptions = {
  repo: string;
  minIntervalMs: number;
  maxIntervalMs: number;
  deferMaxAgeMs: number;
  rateFloor: number;
  shadow: boolean;
  rules: Omit<WatchRules, 'login'>;
};

export type WatchHost = {
  gh: Gh;
  store: StoreLike;
  judge: Judge;
  pack: Pack;
  config: RepoConfig;
  now: () => number;
  deliver: (text: string) => Promise<void>;
  log: (text: string) => void;
  status: (text: string | undefined) => void;
  schedule: (ms: number, fn: () => void) => { cancel: () => void };
  onDecision?: (event: WatchEvent, action: string, label: string) => void;
};

type Timer = { cancel: () => void };

export class Watcher {
  private timer?: Timer;
  private inflight?: Promise<void>;
  private stopped = false;
  private state: WatchState = initialState();

  constructor(
    private readonly host: WatchHost,
    private readonly options: WatchOptions,
  ) {}

  private get key(): string {
    return `watch:${this.options.repo}`;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.state = ((await this.host.store.get(this.key)) as WatchState | undefined) ?? initialState();
    if (!this.state.login && this.options.rules.ignoreSelf) this.state.login = await this.host.gh.login();
    if (this.state.paused) {
      this.host.status(`watch paused (${this.options.repo})`);
      return;
    }
    this.host.status(`watching ${this.options.repo}`);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    this.host.status(undefined);
  }

  async pause(): Promise<void> {
    this.state.paused = true;
    await this.save();
    this.stop();
    this.host.status(`watch paused (${this.options.repo})`);
  }

  async resume(): Promise<void> {
    this.state.paused = false;
    await this.save();
    await this.start();
  }

  async reset(): Promise<void> {
    this.stop();
    this.state = initialState();
    await this.save();
    await this.start();
  }

  snapshot(): WatchState {
    return this.state;
  }

  private async save(): Promise<void> {
    await this.host.store.set(this.key, this.state);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer?.cancel();
    this.timer = this.host.schedule(ms, () => void this.tick());
  }

  // one poll: two conditional probes, a diff, then triage and delivery. a tick during a tick joins it
  tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.stopped) return Promise.resolve();
    this.inflight = this.poll().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async poll(): Promise<void> {
    const now = this.host.now();
    let changed = false;
    let rateWait = 0;
    try {
      const a = await this.pollItems(now);
      const b = await this.pollRuns(now);
      changed = a.changed || b.changed;
      rateWait = Math.max(a.rateWait, b.rateWait);
      this.state.failures = 0;
      if (!this.state.seeded) {
        this.state.seeded = true;
        this.host.log(`sift watch seeded for ${this.options.repo}, streaming changes from now`);
      } else {
        await this.handle([...a.events, ...b.events]);
      }
    } catch (error) {
      this.state.failures += 1;
      if (this.state.failures === 1 || this.state.failures % 10 === 0) {
        this.host.log(`sift watch ${this.options.repo}: poll failed (${error instanceof Error ? error.message : String(error)}), retrying`);
      }
    } finally {
      this.state.lastPoll = now;
      const { minIntervalMs, maxIntervalMs } = this.options;
      if (this.state.failures > 0) this.state.interval = maxIntervalMs;
      else if (changed) this.state.interval = minIntervalMs;
      else this.state.interval = Math.min(maxIntervalMs, Math.max(minIntervalMs, this.state.interval * 2 || minIntervalMs));
      await this.save();
      this.schedule(Math.max(this.state.interval, rateWait));
    }
  }

  private async pollItems(now: number): Promise<{ changed: boolean; events: WatchEvent[]; rateWait: number }> {
    const probe = await this.host.gh.api(`repos/${this.options.repo}/issues?state=all&sort=updated&direction=desc&per_page=1`, {
      etag: this.state.etags.issues,
    });
    const rateWait = this.rateWait(probe.remaining, probe.reset, now);
    if (probe.status === 304) return { changed: false, events: [], rateWait };
    const since = this.state.cursor;
    const cursor = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const raw = await this.host.gh.json<Parameters<typeof toItem>[0][]>(
      `repos/${this.options.repo}/issues?state=all&sort=updated&direction=asc&since=${since}&per_page=100`,
      { paginate: true },
    );
    const fresh = Object.fromEntries(raw.map((r) => [String(r.number), toItem(r)]));
    const events = this.state.seeded ? diffItems(this.state.items, fresh, now) : [];
    this.state.items = { ...this.state.items, ...fresh };
    this.state.cursor = cursor;
    this.state.etags.issues = probe.etag;
    return { changed: true, events, rateWait };
  }

  private async pollRuns(now: number): Promise<{ changed: boolean; events: WatchEvent[]; rateWait: number }> {
    let probe;
    try {
      probe = await this.host.gh.api(`repos/${this.options.repo}/actions/runs?per_page=30`, { etag: this.state.etags.runs });
    } catch (error) {
      // a repo without actions answers 404 or 403; that is not a failure
      if (error instanceof GhError && /http 40[34]/.test(error.message)) return { changed: false, events: [], rateWait: 0 };
      throw error;
    }
    const rateWait = this.rateWait(probe.remaining, probe.reset, now);
    if (probe.status === 304) return { changed: false, events: [], rateWait };
    const parsed = JSON.parse(probe.body || '{}') as { workflow_runs?: Parameters<typeof toRuns>[0] };
    const fresh = toRuns(parsed.workflow_runs ?? []);
    const events = this.state.seeded ? diffRuns(this.state.runs, fresh, now) : [];
    this.state.runs = trimRuns({ ...this.state.runs, ...fresh });
    this.state.etags.runs = probe.etag;
    return { changed: events.length > 0, events, rateWait };
  }

  private rateWait(remaining: number | undefined, reset: number | undefined, now: number): number {
    if (remaining === undefined || remaining >= this.options.rateFloor) return 0;
    const wait = reset ? reset * 1000 - now + 5000 : this.options.maxIntervalMs;
    this.host.log(`sift watch ${this.options.repo}: ${remaining} api calls left, waiting ${Math.round(wait / 1000)}s`);
    return Math.max(wait, this.options.maxIntervalMs);
  }

  private async handle(events: WatchEvent[]): Promise<void> {
    const rules: WatchRules = { ...this.options.rules, login: this.state.login };
    const deliver: { event: WatchEvent; label: string }[] = [];
    for (const e of events) {
      const route = routeByRules(e, rules);
      if (route.action === 'drop') {
        this.host.onDecision?.(e, 'drop', route.reason);
        continue;
      }
      if (route.action === 'defer') {
        this.defer(e, route.reason);
        continue;
      }
      if (route.action === 'deliver' || !this.options.rules.triage) {
        deliver.push({ event: e, label: route.reason });
        continue;
      }
      const detail = await this.detail(e).catch(() => ({}) as EventDetail);
      const triage = await judgeEvent(this.host.pack, eventSubject(this.options.repo, e, detail), this.host.judge, this.host.config);
      const label = triage.error ? `judge unavailable: ${triage.error}` : triage.label;
      if (triage.action === 'defer' && !this.options.shadow) {
        this.defer(e, 'judged not actionable', label);
        continue;
      }
      deliver.push({ event: e, label: this.options.shadow && triage.action === 'defer' ? `${label} (shadow: would defer)` : label });
    }
    this.expireDeferred();
    if (deliver.length === 0) return;
    for (const d of deliver) this.host.onDecision?.(d.event, 'deliver', d.label);
    await this.host.deliver(this.render(deliver));
    this.state.deferred = [];
    this.state.lastDelivery = this.host.now();
  }

  private defer(e: WatchEvent, reason: string, label?: string): void {
    this.host.onDecision?.(e, 'defer', label ?? reason);
    this.state.deferred.push({ event: e, reason, label });
  }

  // a deferred event older than the limit is delivered on its own so nothing waits forever
  private expireDeferred(): void {
    const cutoff = this.host.now() - this.options.deferMaxAgeMs;
    const stale = this.state.deferred.filter((d) => d.event.at < cutoff);
    if (stale.length === 0) return;
    this.state.deferred = this.state.deferred.filter((d) => d.event.at >= cutoff);
    void this.host.deliver(this.render(stale.map((d) => ({ event: d.event, label: `deferred ${d.reason}, aged out` }))));
  }

  private render(items: { event: WatchEvent; label: string }[]): string {
    const lines = [`[sift watch ${this.options.repo}]`];
    for (const { event, label } of items) {
      lines.push(`${formatEvent(event)}`);
      lines.push(`  by ${event.user || 'unknown'} · ${event.url}${label ? ` · ${label}` : ''}`);
    }
    if (this.state.deferred.length > 0) lines.push(`deferred meanwhile: ${summarize(this.state.deferred)}`);
    return lines.join('\n');
  }

  // enough of the item for the triage pack: body, labels, the newest comment or review
  private async detail(e: WatchEvent): Promise<EventDetail> {
    if (e.kind === 'ci' || e.number === undefined) return {};
    const repo = this.options.repo;
    const item = await this.host.gh.json<{ body: string | null; labels: { name: string }[] }>(`repos/${repo}/issues/${e.number}`);
    const detail: EventDetail = { body: item.body ?? '', labels: item.labels.map((l) => l.name) };
    if (e.changes.some((c) => c.startsWith('comments'))) {
      const comments = await this.host.gh.json<{ user: { login: string }; body: string }[]>(
        `repos/${repo}/issues/${e.number}/comments?per_page=1&direction=desc&sort=created`,
      );
      const c = comments[0];
      if (c) detail.latestComment = { by: c.user.login, text: c.body };
    }
    if (e.kind === 'pr' && e.changes.some((c) => c.startsWith('activity'))) {
      const reviews = await this.host.gh.json<{ user: { login: string }; state: string; body: string }[]>(`repos/${repo}/pulls/${e.number}/reviews?per_page=100`);
      const r = reviews[reviews.length - 1];
      if (r) detail.latestReview = { by: r.user.login, state: r.state, text: r.body };
      // a review made of inline comments alone has an empty body, the comments carry the ask
      const inline = await this.host.gh.json<{ user: { login: string }; path: string; body: string }[]>(
        `repos/${repo}/pulls/${e.number}/comments?per_page=1&direction=desc&sort=created`,
      );
      const c = inline[0];
      if (c) detail.latestReviewComment = { by: c.user.login, path: c.path, text: c.body };
    }
    return detail;
  }
}

export function summarize(deferred: Deferred[]): string {
  const counts = new Map<string, number>();
  for (const d of deferred) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${n} ${reason}`).join(', ');
}
