import type { RepoConfig } from '../repo/config.ts';
import type { Forge, PullHead, Rate } from '../forge/forge.ts';
import type { Judge } from '../judge/types.ts';
import type { Finding, Pack } from '../packs/types.ts';
import { formatReport, runChecks, runPack } from '../packs/run.ts';
import { issueSubject } from '../repo/subjects.ts';
import { ciSubject } from '../ci/log.ts';
import type { StoreLike } from '../log.ts';
import { diffItems, diffRuns, formatEvent, initialState, pendingChecks, settleChecks, STATE_VERSION, toItem, toRuns, trimRuns, trimSettled, type Deferred, type WatchEvent, type WatchState } from './poll.ts';
import { eventSubject, judgeEvent, routeByRules, type EventDetail, type WatchRules } from './triage.ts';

export type WatchOptions = {
  repo: string;
  minIntervalMs: number;
  maxIntervalMs: number;
  deferMaxAgeMs: number;
  // how long the checks on a pr head may stay unfinished before the head is delivered as stalled
  stallMs: number;
  // how far back the first poll looks; older items are still tracked from their next change
  seedWindowMs: number;
  rateFloor: number;
  shadow: boolean;
  rules: Omit<WatchRules, 'login'>;
};

export type WatchHost = {
  forge: Forge;
  store: StoreLike;
  judge: Judge;
  pack: Pack;
  // the issue pack's mechanical checks run on every new issue, the filer's own included
  issuePack?: Pack;
  // the ci pack runs on each failed check of a settled pr head and its report rides with the delivery
  ciPack?: Pack;
  config: RepoConfig;
  now: () => number;
  deliver: (text: string) => Promise<void>;
  log: (text: string) => void;
  status: (text: string | undefined) => void;
  schedule: (ms: number, fn: () => void) => { cancel: () => void };
  onDecision?: (event: WatchEvent, action: string, label: string) => void;
};

type Timer = { cancel: () => void };

type Pull = PullHead;

const headKey = (p: Pull): string => `${p.number}@${p.sha}`;

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
    const stored = (await this.host.store.get(this.key)) as WatchState | undefined;
    if (stored && stored.version !== STATE_VERSION) this.host.log(`sift watch ${this.options.repo}: stored state is from an older version, reseeding`);
    this.state = stored && stored.version === STATE_VERSION ? stored : initialState();
    if (!this.state.login && this.options.rules.ignoreSelf) this.state.login = await this.host.forge.login();
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
      const c = await this.pollPulls(now);
      changed = a.changed || b.changed;
      rateWait = Math.max(a.rateWait, b.rateWait, c.rateWait);
      this.state.failures = 0;
      if (!this.state.seeded) {
        this.state.seeded = true;
        if (c.changed) await this.seedHeads(now);
        this.host.log(`sift watch seeded for ${this.options.repo}, streaming changes from now`);
      } else {
        await this.handle([...a.events, ...b.events], c.changed);
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
    const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    // the seed window is fixed before the first read so the read and the cursor agree
    if (!this.state.seeded) {
      this.state.seededAt = stamp(now);
      this.state.cursor = stamp(now - this.options.seedWindowMs);
    }
    const read = await this.host.forge.items(this.options.repo, this.state.cursor, this.state.etags.issues);
    const rateWait = this.rateWait(read.rate, now);
    if (!read.changed) return { changed: false, events: [], rateWait };
    const fresh = Object.fromEntries(read.value.map((i) => [String(i.number), toItem(i)]));
    const events = this.state.seeded ? diffItems(this.state.items, fresh, now, this.state.seededAt) : [];
    this.state.items = { ...this.state.items, ...fresh };
    this.state.cursor = stamp(now);
    this.state.etags.issues = read.token;
    return { changed: true, events, rateWait };
  }

  private async pollRuns(now: number): Promise<{ changed: boolean; events: WatchEvent[]; rateWait: number }> {
    const read = await this.host.forge.runs(this.options.repo, this.state.etags.runs);
    const rateWait = this.rateWait(read.rate, now);
    if (!read.changed) return { changed: false, events: [], rateWait };
    const fresh = toRuns(read.value);
    const events = this.state.seeded ? diffRuns(this.state.runs, fresh, now) : [];
    this.state.runs = trimRuns({ ...this.state.runs, ...fresh });
    this.state.etags.runs = read.token;
    return { changed: events.length > 0, events, rateWait };
  }

  private rateWait({ remaining, reset }: Rate, now: number): number {
    if (remaining === undefined || remaining >= this.options.rateFloor) return 0;
    const wait = reset ? reset * 1000 - now + 5000 : this.options.maxIntervalMs;
    this.host.log(`sift watch ${this.options.repo}: ${remaining} api calls left, waiting ${Math.round(wait / 1000)}s`);
    return Math.max(wait, this.options.maxIntervalMs);
  }

  // the open pr heads, fetched conditionally so an unchanged list costs nothing. a 200 replaces the list in state and
  // every head on it is seeded; the steps of the poll read the list from state either way
  private async pollPulls(now: number): Promise<{ changed: boolean; rateWait: number }> {
    if (this.options.rules.ci === 'none') return { changed: false, rateWait: 0 };
    const read = await this.host.forge.pulls(this.options.repo, this.state.etags.pulls);
    const rateWait = this.rateWait(read.rate, now);
    if (!read.changed) return { changed: false, rateWait };
    this.state.pulls = read.value;
    this.state.etags.pulls = read.token;
    return { changed: true, rateWait };
  }

  private async handle(events: WatchEvent[], fresh: boolean): Promise<void> {
    const rules: WatchRules = { ...this.options.rules, login: this.state.login };
    const deliver: { event: WatchEvent; label: string }[] = [];
    const settled = await this.settleRuns(events);
    const seeded = fresh ? await this.seedHeads(this.host.now()) : [];
    for (const e of [...settled, ...seeded, ...(await this.stallHeads())]) {
      const filing = e.kind === 'issue' && e.isNew && !(rules.ignoreBots && e.bot) ? await this.fileCheck(e) : [];
      if (filing.length > 0) e.findings = filing.map((f) => `${f.check}: ${f.message}`);
      const route = filing.length > 0 ? { action: 'deliver' as const, reason: `filed with ${filing.length} finding${filing.length === 1 ? '' : 's'}` } : routeByRules(e, rules);
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
    for (const d of deliver) {
      this.host.onDecision?.(d.event, 'deliver', d.label);
      if (d.event.settled && d.event.conclusion === 'failure') d.event.reports = await this.ciReports(d.event);
    }
    await this.host.deliver(this.render(deliver));
    this.state.deferred = [];
    this.state.lastDelivery = this.host.now();
  }

  // a completed run on the head of an open pr is reported as the pr's verdict, once, when the last check finishes.
  // until then the run event is held with the pr named and the head is tracked as pending. under ci: all the run events pass through as well
  private async settleRuns(events: WatchEvent[]): Promise<WatchEvent[]> {
    const runs = events.filter((e) => e.kind === 'ci' && !e.settled);
    if (runs.length === 0 || this.options.rules.ci === 'none') return events;
    const out: WatchEvent[] = events.filter((e) => e.kind !== 'ci');
    const pulls = this.state.pulls;
    this.prunePending();
    const sha = (e: WatchEvent) => this.state.runs[e.id.replace(/^ci#/, '')]?.sha ?? '';
    for (const e of runs) {
      const pr = pulls.find((p) => p.sha === sha(e));
      if (!pr) {
        out.push(e);
        continue;
      }
      if (this.options.rules.ci === 'all') out.push(e);
      const key = headKey(pr);
      if (this.state.settled[key]) {
        if (this.options.rules.ci !== 'all') this.host.onDecision?.(e, 'drop', `ci settled on pr #${pr.number} already delivered`);
        continue;
      }
      const head = await this.settle(pr.sha).catch(() => undefined);
      if (!head) continue;
      if (!head.verdict) {
        this.state.pending[key] ??= { ...pr, user: e.user, since: e.at, stalled: false };
        if (this.options.rules.ci !== 'all') this.defer(e, `ci ${e.conclusion ?? 'unknown'} on pr #${pr.number}, awaiting the other checks`);
        continue;
      }
      out.push(this.settledEvent(pr, head.verdict, e.user, e.at));
    }
    return out;
  }

  // a pending head older than the stall interval is checked once more: settled by now it delivers the verdict,
  // still unfinished it delivers as stalled, once. a head that moved or closed is forgotten, so a new commit starts over
  private async stallHeads(): Promise<WatchEvent[]> {
    const now = this.host.now();
    const due = Object.entries(this.state.pending).filter(([, h]) => !h.stalled && now - h.since >= this.options.stallMs);
    if (due.length === 0 || this.options.rules.ci === 'none') return [];
    this.prunePending();
    const out: WatchEvent[] = [];
    for (const [key, h] of due) {
      if (!this.state.pending[key]) continue;
      const head = await this.settle(h.sha).catch(() => undefined);
      if (!head) continue;
      if (head.verdict) {
        out.push(this.settledEvent(h, head.verdict, h.user, now));
        continue;
      }
      h.stalled = true;
      out.push({
        id: `ci-stalled#${key}`,
        kind: 'ci',
        number: h.number,
        title: `${h.branch} @${h.sha.slice(0, 7)}: ${h.title} (${head.pending.length} of ${head.total} checks pending: ${head.pending.join(', ')})`,
        user: h.user,
        bot: false,
        url: h.url,
        changes: ['ci stalled'],
        at: now,
        conclusion: null,
        branch: h.branch,
        stalled: true,
        isNew: true,
      });
    }
    return out;
  }

  private settledEvent(pr: Pull, verdict: NonNullable<ReturnType<typeof settleChecks>>, user: string, at: number): WatchEvent {
    const key = headKey(pr);
    this.state.settled = trimSettled({ ...this.state.settled, [key]: verdict.conclusion });
    delete this.state.pending[key];
    const failed = verdict.failed.length > 0 ? `, failed: ${verdict.failed.map((c) => c.name).join(', ')}` : '';
    return {
      id: `ci-settled#${key}`,
      kind: 'ci',
      number: pr.number,
      title: `${pr.branch} @${pr.sha.slice(0, 7)}: ${pr.title} (${verdict.total} checks${failed})`,
      user,
      bot: false,
      url: pr.url,
      changes: [`ci settled ${verdict.conclusion}`],
      at,
      conclusion: verdict.conclusion,
      ok: verdict.conclusion === 'success',
      branch: pr.branch,
      settled: true,
      failed: verdict.failed,
      isNew: true,
    };
  }

  // the ci pack over each failed check that has a log, one report per job; a check the forge keeps no log for is named alone
  private async ciReports(e: WatchEvent): Promise<string[]> {
    const pack = this.host.ciPack;
    if (!pack) return [];
    const out: string[] = [];
    for (const check of e.failed ?? []) {
      if (check.id === undefined) {
        out.push(`${check.name}: no log to read`);
        continue;
      }
      try {
        const subject = await ciSubject(this.host.forge, this.options.repo, { job: check.id });
        out.push(formatReport(await runPack(pack, subject, this.host.judge, this.host.config)));
      } catch (error) {
        out.push(`${check.name}: could not read the log (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return out;
  }

  // every open head not yet tracked is looked up once: unfinished checks make it pending from now, so a head whose
  // checks never start still stalls; a head already finished is settled (delivered when no run reported it, silently on
  // the seed poll); a head with nothing on it is neither, so a repo without ci sees no verdicts
  private async seedHeads(now: number): Promise<WatchEvent[]> {
    this.prunePending();
    const out: WatchEvent[] = [];
    for (const pr of this.state.pulls) {
      const key = headKey(pr);
      if (this.state.pending[key] || this.state.settled[key] || this.state.unchecked[key]) continue;
      const head = await this.settle(pr.sha).catch(() => undefined);
      if (!head) continue;
      if (head.total === 0) this.state.unchecked[key] = true;
      else if (head.verdict) out.push(this.settledEvent(pr, head.verdict, pr.user, now));
      else this.state.pending[key] = { ...pr, since: now, stalled: false };
    }
    return out;
  }

  // a pending or unchecked head is only worth remembering while it is still the head of an open pr
  private prunePending(): void {
    const live = new Set(this.state.pulls.map(headKey));
    for (const key of Object.keys(this.state.pending)) if (!live.has(key)) delete this.state.pending[key];
    for (const key of Object.keys(this.state.unchecked)) if (!live.has(key)) delete this.state.unchecked[key];
  }

  private async settle(sha: string): Promise<{ verdict: ReturnType<typeof settleChecks>; pending: string[]; total: number }> {
    const checks = await this.host.forge.checks(this.options.repo, sha);
    return { verdict: settleChecks(checks), ...pendingChecks(checks) };
  }

  // mechanical findings of the issue pack on a fresh issue: labels, template, parent, milestone. no judge, no cost beyond the fetch
  private async fileCheck(e: WatchEvent): Promise<Finding[]> {
    const pack = this.host.issuePack;
    if (!pack || e.number === undefined) return [];
    try {
      const subject = await issueSubject(this.host.forge, this.options.repo, e.number, this.host.config);
      return runChecks(pack, subject, this.host.config).filter((f) => f.severity !== 'info');
    } catch (error) {
      this.host.log(`sift watch ${this.options.repo}: could not check issue #${e.number} (${error instanceof Error ? error.message : String(error)})`);
      return [];
    }
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
      if (event.findings?.length) lines.push(`  filing: ${event.findings.join('; ')}`);
      for (const report of event.reports ?? []) lines.push(...report.split('\n').map((l) => `  ${l}`));
    }
    if (this.state.deferred.length > 0) lines.push(`deferred meanwhile: ${summarize(this.state.deferred)}`);
    return lines.join('\n');
  }

  // enough of the item for the triage pack: body, labels, the newest comment or review
  private async detail(e: WatchEvent): Promise<EventDetail> {
    if (e.kind === 'ci' || e.number === undefined) return {};
    const { forge } = this.host;
    const repo = this.options.repo;
    const item = await forge.issue(repo, e.number);
    const detail: EventDetail = { body: item.body, labels: item.labels };
    if (e.changes.some((c) => c.startsWith('comments'))) {
      const c = (await forge.comments(repo, e.kind, e.number, 1))[0];
      if (c) detail.latestComment = { by: c.author.login, text: c.body };
    }
    if (e.kind === 'pr' && e.changes.some((c) => c.startsWith('activity'))) {
      const r = (await forge.reviews(repo, e.number, 1))[0];
      if (r) detail.latestReview = { by: r.author.login, state: r.state, text: r.body };
      // a review made of inline comments alone has an empty body, the comments carry the ask
      const c = (await forge.reviewComments(repo, e.number, 1))[0];
      if (c) detail.latestReviewComment = { by: c.author.login, path: c.path, text: c.body };
    }
    return detail;
  }
}

export function summarize(deferred: Deferred[]): string {
  const counts = new Map<string, number>();
  for (const d of deferred) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${n} ${reason}`).join(', ');
}
