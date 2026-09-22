import type { RepoConfig } from '../repo/config.ts';
import type { Forge, Job, PullHead, Rate } from '../forge/forge.ts';
import type { Judge } from '../judge/types.ts';
import type { Finding, Pack } from '../packs/types.ts';
import { formatReport, runChecks, runPack } from '../packs/run.ts';
import { issueSubject } from '../repo/subjects.ts';
import { downstreamLine, jobSubject, readFailure } from '../ci/log.ts';
import type { StoreLike } from '../log.ts';
import { currentState, diffItems, diffRuns, formatEvent, initialState, newerRun, pendingChecks, recordHeads, runSubject, settleChecks, STATE_VERSION, toItem, toRuns, trimRuns, trimSettled, type Deferred, type Run, type WatchEvent, type WatchState } from './poll.ts';
import { route, settles, type Subscription } from './subscription.ts';
import { eventSubject, judgeEvent, type EventDetail, type WatchRules } from './triage.ts';

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
  deliver: (delivery: WatchDelivery) => Promise<void>;
  log: (text: string) => void;
  status: (text: string | undefined) => void;
  schedule: (ms: number, fn: () => void) => { cancel: () => void };
  onDecision?: (event: WatchEvent, action: string, label: string) => void;
  // the subscriptions on this repository, read at each step so one added or removed mid-poll counts at once
  subscriptions: () => Subscription[];
  // removes subscriptions whose until is reached
  retire?: (ids: string[], why: string) => Promise<void>;
  // runs before each poll: the owner reaps what no longer has anyone to deliver to
  prepare?: () => Promise<void>;
  // the epoch ms before which no poll on this token runs, shared by every poller on it
  rate?: { until: number };
};

// one prompt's worth of events and the subscriptions they matched, each naming the agent it belongs to
export type WatchDelivery = { repo: string; text: string; subscriptions: Subscription[] };

type Timer = { cancel: () => void };

type Delivery = { event: WatchEvent; label: string; subs: string[] };

// what one age-out has read from the forge: the pr heads whose checks it read, the runs of each branch it listed
type Recheck = { heads: Set<string>; branches: Map<string, Run[]> };

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
    this.state = stored && stored.version === STATE_VERSION ? stored : this.fresh();
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
    this.state = this.fresh();
    await this.save();
    await this.start();
  }

  // a run subscription waits on its run: the run is read by id each poll until its completion goes out
  async await(run: string): Promise<void> {
    if (!this.state.awaited.includes(run)) this.state.awaited.push(run);
    await this.save();
  }

  private fresh(): WatchState {
    return { ...initialState(), awaited: this.runSubs() };
  }

  private runSubs(): string[] {
    return [...new Set(this.host.subscriptions().flatMap((s) => (s.scope.kind === 'run' ? [s.scope.id] : [])))];
  }

  private wantsCi(): boolean {
    return this.host.subscriptions().some((s) => s.filter.ci !== 'none');
  }

  private rules(): WatchRules {
    return { ...this.options.rules, login: this.state.login };
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
    await this.host.prepare?.();
    if (this.stopped) return;
    const now = this.host.now();
    let changed = false;
    let rateWait = 0;
    try {
      const a = await this.pollItems(now);
      const b = await this.pollRuns(now);
      const c = await this.pollPulls(now);
      const d = await this.pollAwaited(now, b.events);
      changed = a.changed || b.changed || d.length > 0;
      rateWait = Math.max(a.rateWait, b.rateWait, c.rateWait);
      this.state.failures = 0;
      if (!this.state.seeded) {
        this.state.seeded = true;
        if (c.changed) await this.seedHeads(now);
        this.host.log(`sift watch seeded for ${this.options.repo}, streaming changes from now`);
        // a run subscription is answered on the seed poll too: its completion is what it asked for, not old news
        if (d.length > 0) await this.handle(d, false);
      } else {
        await this.handle([...a.events, ...b.events, ...d], c.changed);
      }
      await this.retireReached();
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
      this.schedule(Math.max(this.state.interval, rateWait, (this.host.rate?.until ?? 0) - now));
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

  // each awaited run the listing did not just report complete is read by id, so a run that paged out of the newest
  // runs still delivers its completion. a run already complete when it was awaited is delivered from the cache
  private async pollAwaited(now: number, listed: WatchEvent[]): Promise<WatchEvent[]> {
    const wanted = new Set(this.runSubs());
    const reported = new Set(listed.map((e) => e.run));
    const out: WatchEvent[] = [];
    const left: string[] = [];
    for (const id of this.state.awaited) {
      if (!wanted.has(id) || reported.has(id)) continue;
      let run = this.state.runs[id];
      if (!run?.done) {
        try {
          run = await this.host.forge.run(this.options.repo, id);
        } catch (error) {
          this.host.log(`sift watch ${this.options.repo}: could not read run ${id} (${error instanceof Error ? error.message : String(error)})`);
          left.push(id);
          continue;
        }
        this.state.runs[id] = run;
      }
      if (run.done) out.push(...diffRuns({}, { [id]: run }, now));
      else left.push(id);
    }
    this.state.awaited = left;
    return out;
  }

  // a pr subscription until merged or closed goes once the pr's state reaches it, as the item cache holds it
  private async retireReached(): Promise<void> {
    const reached = this.host.subscriptions().filter((s) => {
      if (s.scope.kind !== 'pr' || (s.until !== 'merged' && s.until !== 'closed')) return false;
      const item = this.state.items[String(s.scope.number)];
      return item !== undefined && (item.merged || (s.until === 'closed' && item.state === 'closed'));
    });
    if (reached.length > 0) await this.host.retire?.(reached.map((s) => s.id), 'until reached');
  }

  // the floor is per token: a poller that reads it low holds every poller on the token until the window refills
  private rateWait({ remaining, reset }: Rate, now: number): number {
    if (remaining === undefined || remaining >= this.options.rateFloor) return 0;
    const wait = Math.max(reset ? reset * 1000 - now + 5000 : this.options.maxIntervalMs, this.options.maxIntervalMs);
    this.host.log(`sift watch ${this.options.repo}: ${remaining} api calls left, waiting ${Math.round(wait / 1000)}s`);
    if (this.host.rate) this.host.rate.until = Math.max(this.host.rate.until, now + wait);
    return wait;
  }

  // the open pr heads, fetched conditionally so an unchanged list costs nothing. a 200 replaces the list in state and
  // every head on it is seeded; the steps of the poll read the list from state either way
  private async pollPulls(now: number): Promise<{ changed: boolean; rateWait: number }> {
    if (!this.wantsCi()) return { changed: false, rateWait: 0 };
    const read = await this.host.forge.pulls(this.options.repo, this.state.etags.pulls);
    const rateWait = this.rateWait(read.rate, now);
    if (!read.changed) return { changed: false, rateWait };
    this.state.pulls = read.value;
    this.state.heads = recordHeads(this.state.heads, read.value);
    this.state.etags.pulls = read.token;
    return { changed: true, rateWait };
  }

  // every event is routed against the subscriptions on this repository before anything reads or judges it
  private async handle(events: WatchEvent[], fresh: boolean): Promise<void> {
    const rules = this.rules();
    const subs = this.host.subscriptions();
    let deliver: Delivery[] = [];
    for (const e of events) if (e.kind === 'ci' && e.run) e.subject = runSubject(this.state.runs[e.run] ?? e, this.state.heads);
    const settled = await this.settleRuns(events);
    const seeded = fresh ? await this.seedHeads(this.host.now()) : [];
    for (const e of [...settled, ...seeded, ...(await this.stallHeads())]) {
      const routed = route(e, subs, rules);
      if (routed.action === 'drop') {
        this.host.onDecision?.(e, 'drop', routed.reason);
        continue;
      }
      const filing = e.kind === 'issue' && e.isNew ? await this.fileCheck(e) : [];
      if (filing.length > 0) e.findings = filing.map((f) => `${f.check}: ${f.message}`);
      const r = filing.length > 0 ? { action: 'deliver' as const, reason: `filed with ${filing.length} finding${filing.length === 1 ? '' : 's'}` } : routed;
      if (r.action === 'defer') {
        this.defer(e, r.reason, routed.subs);
        continue;
      }
      if (r.action === 'deliver' || !this.options.rules.triage) {
        deliver.push({ event: e, label: r.reason, subs: routed.subs });
        continue;
      }
      const detail = await this.detail(e).catch(() => ({}) as EventDetail);
      const triage = await judgeEvent(this.host.pack, eventSubject(this.options.repo, e, detail), this.host.judge, this.host.config);
      const label = triage.error ? `judge unavailable: ${triage.error}` : triage.label;
      if (triage.action === 'defer' && !this.options.shadow) {
        this.defer(e, 'judged not actionable', routed.subs, label);
        continue;
      }
      deliver.push({ event: e, label: this.options.shadow && triage.action === 'defer' ? `${label} (shadow: would defer)` : label, subs: routed.subs });
    }
    deliver = this.supersede(deliver);
    await this.expireDeferred();
    if (deliver.length === 0) return;
    await this.send(deliver);
    this.state.deferred = [];
  }

  // one delivery, then every until: settled subscription it answered is retired
  private async send(items: Delivery[], extra: Run[] = []): Promise<void> {
    for (const d of items) {
      this.host.onDecision?.(d.event, 'deliver', d.label);
      if (d.event.settled && d.event.conclusion === 'failure') d.event.reports = await this.ciReports(d.event);
    }
    const byId = this.byId();
    const ids = [...new Set(items.flatMap((d) => d.subs))];
    await this.host.deliver({ repo: this.options.repo, text: this.render(items, extra), subscriptions: ids.flatMap((id) => byId.get(id) ?? []) });
    this.state.lastDelivery = this.host.now();
    const used = items.flatMap((d) => d.subs.filter((id) => {
      const sub = byId.get(id);
      return sub?.until === 'settled' && settles(d.event, sub.scope);
    }));
    if (used.length > 0) await this.host.retire?.([...new Set(used)], 'until settled reached');
  }

  private byId(): Map<string, Subscription> {
    return new Map(this.host.subscriptions().map((s) => [s.id, s]));
  }

  // a run subscription asked for its run by id, so nothing newer supersedes the run for it
  private unsuperseded(e: WatchEvent, subs: string[], reason: string | undefined): string[] {
    if (!reason) return subs;
    const byId = this.byId();
    const left = subs.filter((id) => byId.get(id)?.scope.kind === 'run');
    if (left.length === 0) this.host.onDecision?.(e, 'drop', reason);
    return left;
  }

  // drops the ci news a newer result has made old, from this poll's deliveries and from the held events: an older run
  // of the same workflow on the same subject, an earlier completion of a run that completed again, and on a pr whose
  // head settled, everything held for its older heads and the held runs of the settled head
  private supersede(batch: Delivery[]): Delivery[] {
    const held = this.state.deferred.map((d) => d.event);
    const all = [...batch.map((d) => d.event), ...held];
    const verdicts = all.filter((e) => e.settled);
    const runs = Object.values(this.state.runs);
    const by = (e: WatchEvent, isHeld: boolean): string | undefined => {
      if (e.kind !== 'ci' || e.settled || e.stalled || !e.subject) return undefined;
      const verdict = verdicts.find((v) => v.subject === e.subject && (v.sha !== e.sha || isHeld));
      if (verdict) return `superseded by the settled verdict on pr #${verdict.number} @${(verdict.sha ?? '').slice(0, 7)}`;
      if (!e.run) return undefined;
      const newer = newerRun(runs, (r) => r.name === e.workflow && runSubject(r, this.state.heads) === e.subject, e.run);
      if (newer) return `superseded by run ${newer.id}`;
      if (all.some((o) => o !== e && o.run === e.run && o.at > e.at)) return `superseded by run ${e.run} completing again`;
      return undefined;
    };
    this.state.deferred = this.state.deferred.flatMap((d) => {
      const subs = this.unsuperseded(d.event, d.subs, by(d.event, true));
      return subs.length > 0 ? [{ ...d, subs }] : [];
    });
    return batch.flatMap((d) => {
      const subs = this.unsuperseded(d.event, d.subs, by(d.event, false));
      return subs.length > 0 ? [{ ...d, subs }] : [];
    });
  }

  // a completed run on the head of an open pr is reported as the pr's verdict, once, when the last check finishes.
  // the run event passes on marked with where its head stands, so each subscription holds it, drops it or takes it
  private async settleRuns(events: WatchEvent[]): Promise<WatchEvent[]> {
    const runs = events.filter((e) => e.kind === 'ci' && !e.settled);
    if (runs.length === 0 || !this.wantsCi()) return events;
    const out: WatchEvent[] = events.filter((e) => e.kind !== 'ci');
    const pulls = this.state.pulls;
    this.prunePending();
    for (const e of runs) {
      out.push(e);
      const pr = pulls.find((p) => p.sha === e.sha);
      if (!pr) continue;
      const key = headKey(pr);
      if (this.state.settled[key]) {
        e.head = 'settled';
        continue;
      }
      const head = await this.settle(pr.sha).catch(() => undefined);
      if (!head?.verdict) {
        if (head) this.state.pending[key] ??= { ...pr, user: e.user, since: e.at, stalled: false };
        e.head = 'pending';
        continue;
      }
      e.head = 'settled';
      out.push(this.settledEvent(pr, head.verdict, e.user, e.at));
    }
    return out;
  }

  // a pending head older than the stall interval is checked once more: settled by now it delivers the verdict,
  // still unfinished it delivers as stalled, once. a head that moved or closed is forgotten, so a new commit starts over
  private async stallHeads(): Promise<WatchEvent[]> {
    const now = this.host.now();
    const due = Object.entries(this.state.pending).filter(([, h]) => !h.stalled && now - h.since >= this.options.stallMs);
    if (due.length === 0 || !this.wantsCi()) return [];
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
        subject: `pr:${h.number}`,
        sha: h.sha,
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
      subject: `pr:${pr.number}`,
      sha: pr.sha,
      settled: true,
      failed: verdict.failed,
      isNew: true,
    };
  }

  // the ci pack over each failed check that has a log, one report per job; a check the forge keeps no log for is named alone,
  // and a job that failed only because a job it needs failed is named in one line, since that job is judged on its own
  private async ciReports(e: WatchEvent): Promise<string[]> {
    const pack = this.host.ciPack;
    if (!pack) return [];
    const out: string[] = [];
    const runs = new Map<string, Promise<Job[]>>();
    const jobsOf = (run: string): Promise<Job[]> => {
      if (!runs.has(run)) runs.set(run, this.host.forge.jobs(this.options.repo, run));
      return runs.get(run)!;
    };
    for (const check of e.failed ?? []) {
      if (check.id === undefined) {
        out.push(`${check.name}: no log to read`);
        continue;
      }
      try {
        const read = await readFailure(this.host.forge, this.options.repo, check.id, jobsOf);
        if (read.job && read.upstream.length > 0) {
          out.push(downstreamLine(read.job, read.upstream));
          continue;
        }
        const subject = await jobSubject(this.host.forge, this.options.repo, check.id, read.log);
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

  private defer(e: WatchEvent, reason: string, subs: string[], label?: string): void {
    this.host.onDecision?.(e, 'defer', label ?? reason);
    this.state.deferred.push({ event: e, reason, label, subs });
  }

  // a deferred event older than the limit is delivered on its own so nothing waits forever, once its subject is read
  // again: a held run on a pr head that moved is dropped, one on a head that settled meanwhile gives way to the verdict,
  // and one on a branch that has a newer completed run of its workflow is dropped
  private async expireDeferred(): Promise<void> {
    const cutoff = this.host.now() - this.options.deferMaxAgeMs;
    const stale = this.state.deferred.filter((d) => d.event.at < cutoff);
    if (stale.length === 0) return;
    this.state.deferred = this.state.deferred.filter((d) => d.event.at >= cutoff);
    const out: Delivery[] = [];
    const reads: Recheck = { heads: new Set(), branches: new Map() };
    const live = this.byId();
    for (const d of stale) {
      const held = d.subs.filter((id) => live.has(id));
      if (held.length === 0) {
        this.host.onDecision?.(d.event, 'drop', 'no subscription holds it any more');
        continue;
      }
      const subs = this.unsuperseded(d.event, held, await this.recheck(d.event, reads, out));
      if (subs.length > 0) out.push({ event: d.event, label: `deferred ${d.reason}, aged out`, subs });
    }
    if (out.length > 0) await this.send(out, [...reads.branches.values()].flat());
  }

  // why an aged-out event is old news, read from the forge once per head and once per branch. a head that settled
  // meanwhile adds its verdict to the delivery in place of the runs held for it
  private async recheck(e: WatchEvent, reads: Recheck, out: Delivery[]): Promise<string | undefined> {
    if (e.kind !== 'ci' || !e.subject || !e.run) return undefined;
    const pr = /^pr:(\d+)$/.exec(e.subject);
    if (pr) {
      const pull = this.state.pulls.find((p) => p.number === Number(pr[1]));
      if (!pull) return undefined;
      if (pull.sha !== e.sha) return `superseded by head @${pull.sha.slice(0, 7)}`;
      const key = headKey(pull);
      if (!reads.heads.has(key) && !this.state.settled[key]) {
        reads.heads.add(key);
        const head = await this.settle(pull.sha).catch(() => undefined);
        if (head?.verdict) {
          const verdict = this.settledEvent(pull, head.verdict, e.user, this.host.now());
          const routed = route(verdict, this.host.subscriptions(), this.rules());
          if (routed.action === 'deliver') out.push({ event: verdict, label: routed.reason, subs: routed.subs });
        }
      }
      return this.state.settled[key] ? `superseded by the settled verdict on pr #${pull.number} @${pull.sha.slice(0, 7)}` : undefined;
    }
    const branch = e.branch ?? '';
    if (!reads.branches.has(branch)) reads.branches.set(branch, await this.host.forge.branchRuns(this.options.repo, branch).catch(() => []));
    const newer = newerRun([...Object.values(this.state.runs), ...reads.branches.get(branch)!], (r) => r.name === e.workflow && runSubject(r, this.state.heads) === e.subject, e.run);
    return newer ? `superseded by run ${newer.id}` : undefined;
  }

  // each event names the subscriptions it matched and the agents they belong to; the header names an agent only when
  // every subscription in the delivery is that one agent's
  private render(items: Delivery[], extra: Run[] = []): string {
    const byId = this.byId();
    const owners = (ids: string[]) => [...new Set(ids.map((id) => byId.get(id)?.for))];
    const all = owners(items.flatMap((i) => i.subs));
    const by = all.length === 1 ? all[0] : undefined;
    const lines = [`[sift watch ${this.options.repo}${by ? ` for ${by}` : ''}]`];
    for (const { event, label, subs } of items) {
      const agents = owners(subs).filter((a): a is string => a !== undefined);
      const now = event.kind === 'ci' && event.subject ? ` · now: ${currentState(event, this.state, extra)}` : '';
      lines.push(`${agents.length > 0 ? `for ${agents.join(', ')}: ` : ''}${formatEvent(event)}${now}`);
      lines.push(`  by ${event.user || 'unknown'} · ${event.url}${label ? ` · ${label}` : ''} · ${subs.join(', ')}`);
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

// the name SendMessage reaches a tool.call's agent by: its listed name, else its id, nothing on the main loop
export function agentName(agentId: string | undefined, agents: { id: string; name?: string }[]): string | undefined {
  if (!agentId) return undefined;
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}

// what a subagent that subscribed is told: the plugin submits prompts to the session's main loop only
export function ownerNotice(by: string): string {
  return `subscribed for agent ${by}: deliveries are submitted to the session's main loop, not to this agent. Nothing reaches you unless the session relays it (each delivery for you names you as \`for ${by}\`), so do not end your turn expecting a delivery to arrive on its own.`;
}

export function summarize(deferred: Deferred[]): string {
  const counts = new Map<string, number>();
  for (const d of deferred) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${n} ${reason}`).join(', ');
}
