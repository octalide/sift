import { describe, expect, it } from 'vitest';
import type { Check, Conditional, Run, WatchItem } from '../src/forge/forge.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/repo/config.ts';
import type { Judge, Questions } from '../src/judge/types.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { currentState, diffItems, diffRuns, hashOf, initialState, newerRun, pendingChecks, recordHeads, runSubject, settleChecks, STATE_VERSION, toItem, type Item, type WatchEvent } from '../src/watch/poll.ts';
import { Watches, type AgentLike, type WatchesHost } from '../src/watch/registry.ts';
import { formatSubscription, globMatch, parseScope, parseUntil, route, routeCi, subscriptionOf, type CiFilter, type Scope, type Subscription } from '../src/watch/subscription.ts';
import { routeByRules, type WatchRules } from '../src/watch/triage.ts';
import { agentName, ownerNotice, Watcher, summarize, type WatchDelivery, type WatchHost } from '../src/watch/watcher.ts';
import { fakeForge } from './fake-forge.ts';
import { memoryStore } from './fake-source.ts';

const rules: WatchRules = { ignoreSelf: true, ignoreBots: true, triage: true, login: 'me', protectedBranches: ['main', 'dev'], branchPattern: '^(feat|fix)/\\d+$' };

// a subscription on o/r with the given scope and ci filter, items and stalls on
function sub(id: string, scope: Scope = { kind: 'repo' }, ci: CiFilter = 'failures', over: Partial<Subscription> = {}): Subscription {
  return { id, repo: 'o/r', scope, filter: { items: true, ci, stall: true }, ...over };
}
const repoSub = (ci: CiFilter = 'failures') => [sub('s1', { kind: 'repo' }, ci)];

function event(over: Partial<WatchEvent>): WatchEvent {
  return { id: 'x', kind: 'issue', number: 1, title: 't', user: 'alice', bot: false, url: 'u', changes: ['comments 1->2'], at: 0, isNew: false, ...over };
}

describe('item diffing', () => {
  const item = (over: Partial<Item> = {}): Item => ({ kind: 'issue', title: 'T', state: 'open', user: 'alice', bot: false, bodySig: `1:${hashOf('b')}`, created: '2026-01-01', comments: 1, labels: 'bug', updated: '1', merged: false, url: 'u', ...over });

  it('names each change and reports silent activity', () => {
    const old = { '1': item(), '2': item() };
    const fresh = { '1': item({ comments: 2, labels: 'bug,p1' }), '2': item({ updated: '2' }), '3': item({ kind: 'pr' }) };
    const events = diffItems(old, fresh, 5);
    expect(events.map((e) => e.changes.join('|'))).toEqual(['comments 1->2|labels [bug,p1]', 'activity (review or other)', 'new [open]']);
    expect(events[2]).toMatchObject({ kind: 'pr', isNew: true });
  });

  it('reports a run once, when it completes', () => {
    const run: Run = { id: '1', name: 'ci', branch: 'main', tag: false, event: 'push', done: true, conclusion: 'failure', ok: false, sha: 'abc', url: 'u', actor: 'a', updatedAt: '1' };
    const running: Run = { ...run, done: false, conclusion: null };
    expect(diffRuns({}, { '1': running }, 0)).toHaveLength(0);
    expect(diffRuns({ '1': running }, { '1': run }, 0)).toHaveLength(1);
    expect(diffRuns({ '1': run }, { '1': run }, 0)).toHaveLength(0);
  });

  it('settles a head only once every check has finished', () => {
    const done: Check = { name: 'build', done: true, conclusion: 'success', ok: true };
    const running: Check = { name: 'test', done: false, conclusion: null, ok: false };
    const ext = (state: string): Check => ({ name: 'ext', done: state !== 'pending', conclusion: state === 'pending' ? null : state, ok: state === 'success' });
    expect(settleChecks([done, running])).toBeUndefined();
    expect(settleChecks([done, ext('pending')])).toBeUndefined();
    expect(settleChecks([done, { ...running, done: true, conclusion: 'success', ok: true }, ext('success')])).toEqual({ conclusion: 'success', total: 3, failed: [] });
    expect(settleChecks([done, { ...running, done: true, conclusion: 'failure' }])).toEqual({ conclusion: 'failure', total: 2, failed: [{ name: 'test' }] });
    expect(settleChecks([{ ...running, id: '7', done: true, conclusion: 'failure' }])!.failed).toEqual([{ name: 'test', id: '7' }]);
    expect(settleChecks([])).toEqual({ conclusion: 'success', total: 0, failed: [] });
    expect(pendingChecks([done, running, ext('pending')])).toEqual({ pending: ['test', 'ext'], total: 3 });
  });

  it('keeps no bodies in the store', () => {
    const i = toItem({ kind: 'issue', number: 1, title: 't', state: 'open', author: { login: 'x[bot]', bot: true }, body: { length: 9, head: 'long body' }, comments: 0, labels: ['p1', 'bug'], updatedAt: '1', createdAt: '2026-02-01', url: 'u', merged: false });
    expect(i.bot).toBe(true);
    expect(i.labels).toBe('bug,p1');
    expect(JSON.stringify(i)).not.toContain('long body');
  });

  it('reports an unseen item created before the seed as activity, not new', () => {
    const events = diffItems({}, { '9': item({ created: '2025-01-01' }), '10': item({ created: '2026-03-01' }) }, 0, '2026-02-01');
    expect(events.map((e) => e.isNew)).toEqual([false, true]);
    expect(events[0]!.changes[0]).toMatch(/first seen/);
  });
});

describe('rules', () => {
  it('settles ci without the judge, per subscription filter', () => {
    const ci = (over: Partial<WatchEvent>) => event({ kind: 'ci', run: '1', ...over });
    const repo = (f: CiFilter) => sub('s', { kind: 'repo' }, f);
    expect(routeCi(ci({ conclusion: 'success', ok: true, branch: 'feat/12', settled: true }), repo('failures'), rules).action).toBe('deliver');
    expect(routeCi(ci({ conclusion: 'success', ok: true, branch: 'feat/12', settled: true }), repo('none'), rules).action).toBe('drop');
    expect(routeCi(ci({ conclusion: 'failure', branch: 'main' }), repo('failures'), rules).action).toBe('deliver');
    expect(routeCi(ci({ conclusion: 'failure', branch: 'feat/12' }), repo('failures'), rules).action).toBe('deliver');
    expect(routeCi(ci({ conclusion: 'failure', branch: 'scratch' }), repo('failures'), rules).action).toBe('defer');
    expect(routeCi(ci({ conclusion: 'success', ok: true, branch: 'main' }), repo('failures'), rules).action).toBe('defer');
    expect(routeCi(ci({ conclusion: 'success', ok: true }), repo('all'), rules).action).toBe('deliver');
    expect(routeCi(ci({ conclusion: 'failure' }), repo('none'), rules).action).toBe('drop');
    // settled takes verdicts, and completed runs only where the scope names a subject
    expect(routeCi(ci({ conclusion: 'failure', branch: 'main' }), repo('settled'), rules).action).toBe('drop');
    expect(routeCi(ci({ conclusion: 'success', ok: true, branch: 'v1', subject: 'tag:v1' }), sub('s', { kind: 'tag', glob: 'v*' }, 'settled'), rules).action).toBe('deliver');
    // a failure in a named scope is delivered wherever the branch is; a run subscription takes its run whatever it concluded
    expect(routeCi(ci({ conclusion: 'failure', branch: 'scratch' }), sub('s', { kind: 'branch', name: 'scratch' }), rules).action).toBe('deliver');
    expect(routeCi(ci({ conclusion: 'success', ok: true, head: 'pending', subject: 'pr:3' }), sub('s', { kind: 'run', id: '1' }), rules).action).toBe('deliver');
    // a run on a pr head is held until the head settles, and dropped once its verdict is out
    expect(routeCi(ci({ conclusion: 'failure', head: 'pending', subject: 'pr:3' }), repo('failures'), rules)).toEqual({ action: 'defer', reason: 'ci failure on pr #3, awaiting the other checks' });
    expect(routeCi(ci({ conclusion: 'failure', head: 'settled', subject: 'pr:3' }), repo('failures'), rules).action).toBe('drop');
    expect(routeCi(ci({ stalled: true }), { ...repo('failures'), filter: { items: true, ci: 'failures', stall: false } }, rules).action).toBe('drop');
  });

  it('routes an event once, naming every subscription that takes it, and drops what none covers', () => {
    const subs = [sub('s1', { kind: 'pr', number: 3 }, 'settled'), sub('s2', { kind: 'branch', name: 'feat/3' }, 'failures'), sub('s3', { kind: 'repo' }, 'none'), sub('s4', { kind: 'run', id: '9' })];
    const verdict = event({ kind: 'ci', number: 3, branch: 'feat/3', subject: 'pr:3', settled: true, conclusion: 'success', ok: true });
    expect(route(verdict, subs, rules)).toEqual({ action: 'deliver', reason: 'ci settled on pr', subs: ['s1', 's2'] });
    expect(route(event({ kind: 'ci', run: '5', branch: 'dev', subject: 'branch:dev', conclusion: 'failure' }), subs.slice(0, 2), rules)).toEqual({ action: 'drop', reason: 'no subscription covers it', subs: [] });
    // items reach a pr subscription on its own pr only, and a repo subscription unless it turned items off
    expect(route(event({ kind: 'pr', number: 3, changes: ['merged'] }), subs, rules).subs).toEqual(['s1', 's3']);
    expect(route(event({ kind: 'pr', number: 4, changes: ['merged'] }), subs.slice(0, 2), rules).action).toBe('drop');
    expect(route(event({ kind: 'issue', number: 3 }), [sub('s5', { kind: 'repo' }, 'failures', { filter: { items: false, ci: 'failures', stall: true } })], rules)).toMatchObject({ action: 'drop', reason: 'items off' });
  });

  it('reads a subscribe or start from the tool input, the owner from the calling agent', () => {
    const how = { start: false, repo: 'o/r', filter: { items: true, ci: 'failures' as const, stall: true }, owner: 'issue-9' };
    expect(subscriptionOf({ repo: 'o/x', scope: 'tag v*', ci: 'settled', items: false, until: 'settled' }, how)).toEqual({ repo: 'o/x', scope: { kind: 'tag', glob: 'v*' }, filter: { items: false, ci: 'settled', stall: true }, for: 'issue-9', until: 'settled' });
    expect(subscriptionOf({ scope: 'pr 4', until: 'merged' }, { ...how, owner: undefined })).toEqual({ repo: 'o/r', scope: { kind: 'pr', number: 4 }, filter: how.filter, until: 'merged' });
    expect(subscriptionOf({ ci: 'some' }, how)).toEqual({ error: 'ci must be one of settled, failures, all, none' });
    expect(subscriptionOf({ scope: 'branch dev', until: 'closed' }, how)).toEqual({ error: 'until closed needs a pr scope' });
    expect(subscriptionOf({}, { ...how, repo: undefined })).toMatchObject({ error: expect.stringMatching(/no repository/) });
    // start: the session's repository, scoped by for to a pull request or a branch
    expect(subscriptionOf({ repo: 'o/x', for: '#12' }, { ...how, start: true })).toMatchObject({ repo: 'o/r', scope: { kind: 'pr', number: 12 }, for: 'issue-9' });
    expect(subscriptionOf({ for: 'feat/12' }, { ...how, start: true })).toMatchObject({ scope: { kind: 'branch', name: 'feat/12' } });
    expect(subscriptionOf({}, { ...how, start: true, owner: undefined })).toEqual({ repo: 'o/r', scope: { kind: 'repo' }, filter: how.filter });
  });

  it('parses scopes and untils, and matches tag globs', () => {
    expect(parseScope(undefined)).toEqual({ kind: 'repo' });
    expect(parseScope('pr #12')).toEqual({ kind: 'pr', number: 12 });
    expect(parseScope('branch feat/12')).toEqual({ kind: 'branch', name: 'feat/12' });
    expect(parseScope('run 123')).toEqual({ kind: 'run', id: '123' });
    expect(parseScope('tag v1.*')).toEqual({ kind: 'tag', glob: 'v1.*' });
    expect(parseScope('run abc')).toMatch(/run id/);
    expect(parseScope('commit abc')).toMatch(/scope must be/);
    expect(parseUntil('merged', { kind: 'pr', number: 1 })).toBe('merged');
    expect(parseUntil('merged', { kind: 'repo' })).toEqual({ error: 'until merged needs a pr scope' });
    expect(parseUntil('2026-09-23T00:00:00Z', { kind: 'repo' })).toBe('2026-09-23T00:00:00.000Z');
    expect(parseUntil('soon', { kind: 'repo' })).toMatchObject({ error: expect.stringMatching(/iso time/) });
    expect(globMatch('v1.*', 'v1.2.0')).toBe(true);
    expect(globMatch('v1.*', 'v10.0')).toBe(false);
    expect(globMatch('release/*', 'release/v2')).toBe(true);
    expect(formatSubscription(sub('s1', { kind: 'pr', number: 3 }, 'settled', { for: 'issue-3', until: 'merged' }))).toBe('s1 o/r pr 3 · items, ci settled, stall · for issue-3 · until merged');
  });

  it('defers own writes and housekeeping, drops bots, judges content', () => {
    expect(routeByRules(event({ user: 'me' }), rules).action).toBe('defer');
    expect(routeByRules(event({ user: 'me' }), { ...rules, ignoreSelf: false }).action).toBe('judge');
    expect(routeByRules(event({ bot: true }), rules).action).toBe('drop');
    expect(routeByRules(event({ changes: ['labels [x]'] }), rules).action).toBe('defer');
    expect(routeByRules(event({ changes: ['body edited'] }), rules).action).toBe('judge');
    expect(routeByRules(event({ isNew: true, kind: 'pr' }), rules).action).toBe('deliver');
    expect(routeByRules(event({ isNew: true }), rules).action).toBe('judge');
    expect(routeByRules(event({ changes: ['state open->closed'] }), rules).action).toBe('defer');
    expect(routeByRules(event({ changes: ['merged'] }), rules).action).toBe('deliver');
  });
});

// each read answers the next scripted value; a read past the script is unchanged
function script<T>(...values: (Conditional<T> | (() => Conditional<T>))[]): () => Promise<Conditional<T>> {
  let i = 0;
  return async () => {
    const next = values[i++];
    return next === undefined ? { changed: false, rate: {} } : typeof next === 'function' ? next() : next;
  };
}

const changed = <T>(value: T, token = 'e'): Conditional<T> => ({ changed: true, token, rate: { remaining: 4000 }, value });
const same = <T>(): Conditional<T> => ({ changed: false, rate: { remaining: 4000 } });
const slim = (n: number, over: Partial<WatchItem> = {}): WatchItem => ({ kind: 'issue', number: n, title: `Issue ${n}`, state: 'open', author: { login: 'alice', bot: false }, body: { length: 1, head: 'b' }, comments: 0, labels: [], updatedAt: `2026-01-0${n}T00:00:00Z`, createdAt: `2026-01-0${n}T00:00:00Z`, url: `https://x/${n}`, merged: false, ...over });
const run = (id: number, name: string, done: boolean, conclusion: string | null, sha = 'abc1234def'): Run => ({ id: String(id), name, branch: 'feat/3', tag: false, event: 'push', done, conclusion, ok: conclusion === 'success', sha, url: `https://x/runs/${id}`, actor: 'me', updatedAt: '1' });
const check = (name: string, done: boolean, conclusion: string | null = done ? 'success' : null): Check => ({ name, done, conclusion, ok: conclusion === 'success' });
const pull = (sha = 'abc1234def') => ({ number: 3, title: 'Feat 3', branch: 'feat/3', sha, url: 'https://x/pull/3', user: 'alice' });

describe('watcher', () => {
  it('seeds silently, then delivers judged events and defers the rest with a digest', async () => {
    const forge = fakeForge({
      // tick 1 seeds; tick 2: issue 2 got a comment (judged), issue 1 got a label (deferred)
      items: script(changed([slim(1), slim(2)]), changed([slim(1, { labels: ['p1'] }), slim(2, { comments: 1, updatedAt: '2026-01-03T00:00:00Z' })], 'f')),
      runs: script(changed([])),
      issue: async (_r, n) => ({ ...slim(n), body: 'b', state: 'open' }),
      comments: async () => [{ author: { login: 'bob', bot: false }, body: 'is this still planned?', createdAt: '2026-01-03T00:00:00Z' }],
    });
    const store = new Map<string, unknown>();
    const delivered: string[] = [];
    const judge: Judge = {
      name: 'fake',
      ask: async (_s, q: Questions) => ({
        ok: true,
        backend: 'fake',
        latencyMs: 1,
        answers: {
          actionable: { type: 'noul', p: 0.9 },
          kind: { type: 'choice', choice: 'question', probabilities: {}, confidence: 0.8 },
          urgency: { type: 'score', score: 1, expected: 1, legend: 'soon: x', probabilities: [0, 1, 0], confidence: 0.7 },
          ...Object.fromEntries(Object.keys(q).filter((k) => !['actionable', 'kind', 'urgency'].includes(k)).map((k) => [k, { type: 'noul' as const, p: 0.5 }])),
        },
      }),
    };
    const scheduled: (() => void)[] = [];
    const watcher = new Watcher(
      {
        forge,
        store: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))) },
        judge,
        pack: BUILTIN_PACKS['triage']!,
        config: DEFAULT_CONFIG,
        now: () => 1_000_000,
        deliver: async (d) => void delivered.push(d.text),
        subscriptions: () => repoSub(),
        log: () => {},
        status: () => {},
        schedule: (_ms, fn) => {
          scheduled.push(fn);
          return { cancel: () => {} };
        },
      },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: { ignoreSelf: false, ignoreBots: true, triage: true, protectedBranches: ['main'] } },
    );
    await watcher.start();
    await watcher.tick();
    expect(delivered).toHaveLength(0);
    expect(watcher.snapshot().seeded).toBe(true);
    await watcher.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('issue #2 comments 0->1: Issue 2');
    expect(delivered[0]).toContain('actionable 0.90, kind question, urgency soon');
    expect(delivered[0]).toContain('deferred meanwhile: 1 housekeeping');
    expect(scheduled.length).toBeGreaterThan(0);
    expect(summarize([{ event: event({}), reason: 'a', subs: [] }, { event: event({}), reason: 'a', subs: [] }])).toBe('2 a');
  });

  const silent = (over: Partial<WatchHost> = {}) => ({
    store: { get: async () => undefined, set: async () => {} },
    judge: { name: 'fake', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'fake' }) } as Judge,
    pack: BUILTIN_PACKS['triage']!,
    config: DEFAULT_CONFIG,
    log: () => {},
    status: () => {},
    schedule: () => ({ cancel: () => {} }),
    subscriptions: () => repoSub(),
    ...over,
  });
  const ciRules = { ignoreSelf: true, ignoreBots: true, triage: false, protectedBranches: ['main'], branchPattern: '^feat/\\d+$' };

  it('delivers one settled verdict per pr head when the last check completes', async () => {
    let test = false;
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      // tick 1: both running, the pr not yet open. tick 2: build finished, test still running, the pr opened. tick 3: test finished too, the head list unchanged
      runs: script(changed([run(10, 'build', false, null), run(11, 'test', false, null)]), changed([run(10, 'build', true, 'success'), run(11, 'test', false, null)], 'r2'), () => {
        test = true;
        return changed([run(10, 'build', true, 'success'), run(11, 'test', true, 'success')], 'r3');
      }),
      pulls: script(same(), changed([pull()]), same()),
      checks: async () => [check('build', true), check('test', test)],
    });
    const delivered: string[] = [];
    const decisions: string[] = [];
    const watcher = new Watcher(
      { forge, ...silent(), now: () => 1_000_000, deliver: async (d) => void delivered.push(d.text), onDecision: (e, action, label) => decisions.push(`${action} ${e.id} ${label}`) },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: ciRules },
    );
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    expect(delivered).toHaveLength(0);
    expect(decisions).toContain('defer ci#10 ci success on pr #3, awaiting the other checks');
    await watcher.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('ci settled success: pr #3 feat/3 @abc1234: Feat 3 (2 checks)');
    expect(delivered[0]).toContain('https://x/pull/3 · ci settled on pr');
    expect(watcher.snapshot().settled).toEqual({ '3@abc1234def': 'success' });
    expect(watcher.snapshot().pending).toEqual({});
  });

  it('attaches the ci pack report on each failed check, one job per check, to a settled failure', async () => {
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      // tick 1: running, the pr not yet open. tick 2: both finished, test failed; the log read lists the open prs once more
      runs: script(changed([run(10, 'build', false, null)]), changed([run(10, 'build', true, 'failure')], 'r2')),
      pulls: script(same(), changed([pull()]), changed([pull()])),
      checks: async () => [check('build', true), { ...check('test', true, 'failure'), id: '7' }, check('ext', true, 'error')],
      jobLog: async (_r, id) => ({ job: `job ${id}`, run: '10', sha: 'abc1234def', url: `https://x/job/${id}`, steps: [{ name: 'Run npm test', ok: false, text: '2026-09-21T02:35:35.0000000Z FAIL tests/a.test.ts\n2026-09-21T02:35:36.0000000Z ##[error]Process completed with exit code 1.' }] }),
      diff: async () => 'diff --git a/tests/a.test.ts b/tests/a.test.ts\n+x\n',
    });
    const judge: Judge = {
      name: 'fake',
      ask: async (_s, q: Questions) => ({ ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'noul' as const, p: k === 'environment' ? 0.1 : 0.9 }])) }),
    };
    const delivered: string[] = [];
    const watcher = new Watcher(
      { forge, ...silent({ judge, ciPack: BUILTIN_PACKS['ci']! }), now: () => 1_000_000, deliver: async (d) => void delivered.push(d.text) },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: ciRules },
    );
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    expect(delivered).toHaveLength(1);
    const lines = delivered[0]!.split('\n');
    expect(lines[1]).toBe('ci settled failure: pr #3 feat/3 @abc1234: Feat 3 (3 checks, failed: test, ext) · now: open, head unchanged');
    expect(lines[2]).toBe('  by me · https://x/pull/3 · ci settled on pr · s1');
    expect(lines[3]).toBe('  sift ci o/r job 7: PASS (judge: fake)');
    expect(lines[4]).toBe('    [info] log.trimmed: 2 of 2 lines read from the failing step Run npm test');
    expect(lines[5]).toBe('    lines: top 2 of 2, 2 not ruled out');
    expect(lines[6]).toBe('      1. [satisfied] 1: FAIL tests/a.test.ts = 0.90');
    expect(lines.slice(8, 11).map((l) => l.slice(0, 28))).toEqual(['    [satisfied] own_fault = ', '    [violated] environment =', '    [satisfied] fixable_here']);
    expect(lines[11]).toBe('  ext: no log to read');
  });

  it('delivers a pr head whose checks stay unfinished past the stall interval as stalled, once, then its verdict when it settles', async () => {
    let test = false;
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      // tick 1: both running, the pr not yet open. tick 2: build finished, the head is pending. ticks 3 and 4: nothing moved. tick 5: test finished
      runs: script(changed([run(10, 'build', false, null), run(11, 'test', false, null)]), changed([run(10, 'build', true, 'success'), run(11, 'test', false, null)], 'r2'), same(), same(), () => {
        test = true;
        return changed([run(10, 'build', true, 'success'), run(11, 'test', true, 'success')], 'r3');
      }),
      pulls: script(same(), changed([pull()]), same(), same(), same()),
      checks: async () => [check('build', true), check('test', test)],
    });
    let pullReads = 0;
    const probe = forge.pulls.bind(forge);
    forge.pulls = (...args) => (pullReads += 1, probe(...args));
    const delivered: string[] = [];
    let now = 1_000_000;
    const watcher = new Watcher(
      { forge, ...silent(), now: () => now, deliver: async (d) => void delivered.push(d.text) },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 3600_000, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: ciRules },
    );
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    expect(delivered).toHaveLength(0);
    expect(watcher.snapshot().pending).toEqual({ '3@abc1234def': { number: 3, title: 'Feat 3', branch: 'feat/3', sha: 'abc1234def', url: 'https://x/pull/3', user: 'me', since: 1_000_000, stalled: false } });
    expect(watcher.snapshot().pulls).toEqual([pull()]);
    now += 3600_000;
    await watcher.tick();
    // the stall check read the head list from state: one probe per tick, no refetch behind the 304
    expect(pullReads).toBe(3);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('ci stalled: pr #3 feat/3 @abc1234: Feat 3 (1 of 2 checks pending: test)');
    expect(delivered[0]).toContain('by me · https://x/pull/3 · ci stalled on pr');
    expect(delivered[0]).toContain('deferred meanwhile: 1 ci success on pr #3, awaiting the other checks');
    now += 3600_000;
    await watcher.tick();
    expect(delivered).toHaveLength(1);
    expect(watcher.snapshot().pending['3@abc1234def']?.stalled).toBe(true);
    await watcher.tick();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toContain('ci settled success: pr #3 feat/3 @abc1234: Feat 3 (2 checks)');
    expect(watcher.snapshot().pending).toEqual({});
  });

  it('forgets a pending head once its pr moved to a new commit', async () => {
    let sha = 'aaa1234';
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      // tick 2: build finished on the first head, an external status still pending. tick 3: past the stall interval, but the pr head moved on: the new head starts over
      runs: script(changed([run(10, 'build', false, null, 'aaa1234')]), changed([run(10, 'build', true, 'success', 'aaa1234')], 'r2'), () => {
        sha = 'bbb1234';
        return same();
      }),
      pulls: script(same(), () => changed([pull(sha)]), () => changed([pull(sha)])),
      checks: async (_r, at) => [...(at === 'aaa1234' ? [check('build', true)] : []), { name: 'ext', done: false, conclusion: null, ok: false }],
    });
    const delivered: string[] = [];
    let now = 1_000_000;
    const watcher = new Watcher(
      { forge, ...silent(), now: () => now, deliver: async (d) => void delivered.push(d.text) },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 3600_000, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: ciRules },
    );
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    expect(Object.keys(watcher.snapshot().pending)).toEqual(['3@aaa1234']);
    now += 3600_000;
    await watcher.tick();
    expect(delivered).toHaveLength(0);
    expect(watcher.snapshot().pending).toEqual({ '3@bbb1234': { number: 3, title: 'Feat 3', branch: 'feat/3', sha: 'bbb1234', url: 'https://x/pull/3', user: 'alice', since: now, stalled: false } });
  });

  it('delivers a pr head with no runs at all as stalled after the stall interval', async () => {
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      // tick 1: seed with the pr open, its only check queued and no run reported. tick 2: nothing changed. tick 3: past the stall interval, the check still queued
      runs: script(changed([])),
      pulls: script(changed([pull()]), same(), same()),
      checks: async () => [check('build', false)],
    });
    const delivered: string[] = [];
    let now = 1_000_000;
    const watcher = new Watcher(
      { forge, ...silent(), now: () => now, deliver: async (d) => void delivered.push(d.text) },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 3600_000, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: ciRules },
    );
    await watcher.start();
    await watcher.tick();
    expect(watcher.snapshot().pending).toEqual({ '3@abc1234def': { number: 3, title: 'Feat 3', branch: 'feat/3', sha: 'abc1234def', url: 'https://x/pull/3', user: 'alice', since: 1_000_000, stalled: false } });
    await watcher.tick();
    expect(delivered).toHaveLength(0);
    now += 3600_000;
    await watcher.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('ci stalled: pr #3 feat/3 @abc1234: Feat 3 (1 of 1 checks pending: build)');
    expect(delivered[0]).toContain('by alice · https://x/pull/3 · ci stalled on pr');
    expect(watcher.snapshot().pending['3@abc1234def']?.stalled).toBe(true);
  });

  it('tells a subagent that subscribed where deliveries go, by the name SendMessage reaches it by', () => {
    const agents = [{ id: 'a1', name: 'issue-113' }, { id: 'a2' }];
    expect(agentName(undefined, agents)).toBeUndefined();
    expect(agentName('a1', agents)).toBe('issue-113');
    expect(agentName('a2', agents)).toBe('a2');
    expect(agentName('a3', agents)).toBe('a3');
    const notice = ownerNotice('issue-113');
    expect(notice).toContain('subscribed for agent issue-113');
    expect(notice).toContain("session's main loop");
    expect(notice).toContain('for issue-113');
  });

  it('checks a new issue against the issue pack, the filer\'s own included, and delivers its findings', async () => {
    const forge = fakeForge({
      login: async () => 'me',
      // tick 2: me filed issue 2 with no labels and a task label but no parent
      items: script(changed([slim(1)]), changed([slim(2, { author: { login: 'me', bot: false }, labels: ['task'], createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' })], 'f')),
      runs: script(changed([])),
      issue: async (_r, n) => ({ ...slim(n), state: 'open', author: { login: 'me', bot: false }, labels: ['task'], body: '## Summary\nthe summary' }),
      openIssues: async () => [{ number: 2, title: 'Issue 2' }],
    });
    const delivered: string[] = [];
    const config = resolveConfig({ issues: { requiredLabelGroups: [['bug', 'enhancement']], childLabels: ['task'], templateSections: ['Summary', 'Acceptance'] } });
    const watcher = new Watcher(
      { forge, ...silent({ config, issuePack: BUILTIN_PACKS['issue']! }), now: () => 1_750_000_000_000, deliver: async (d) => void delivered.push(d.text) },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: { ignoreSelf: true, ignoreBots: true, triage: false, protectedBranches: ['main'] } },
    );
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('issue #2 new [open]: Issue 2');
    expect(delivered[0]).toContain('· filed with 3 findings');
    expect(delivered[0]).toContain('filing: issue.labels: needs one of: bug, enhancement; issue.template: missing section: Acceptance; issue.parent: labeled as a child but has no parent sub-issue link');
  });
});

describe('superseded ci news', () => {
  const H = 3600_000;
  const brun = (id: number, name: string, branch: string, conclusion: string, sha: string): Run => ({ id: String(id), name, branch, tag: false, event: 'push', done: true, conclusion, ok: conclusion === 'success', sha, url: `https://x/runs/${id}`, actor: 'me', updatedAt: '1' });
  const pr3 = (sha: string) => ({ number: 3, title: 'Feat 3', branch: 'feat/3', sha, url: 'https://x/pull/3', user: 'alice' });
  const ext = (done: boolean): Check => ({ name: 'ext', done, conclusion: done ? 'success' : null, ok: done });
  const rulesFor = () => ({ ignoreSelf: true, ignoreBots: true, triage: false, protectedBranches: ['main', 'dev'], branchPattern: '^feat/\\d+$' });
  const host = (forge: ReturnType<typeof fakeForge>, clock: { now: number }, store = new Map<string, unknown>(), ci: CiFilter = 'failures') => {
    const delivered: string[] = [];
    const decisions: string[] = [];
    const h: WatchHost = {
      forge,
      store: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))) },
      judge: { name: 'fake', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'fake' }) } as Judge,
      pack: BUILTIN_PACKS['triage']!,
      config: DEFAULT_CONFIG,
      now: () => clock.now,
      deliver: async (d) => void delivered.push(d.text),
      log: () => {},
      status: () => {},
      schedule: () => ({ cancel: () => {} }),
      onDecision: (e, action, label) => decisions.push(`${action} ${e.id} ${label}`),
      subscriptions: () => repoSub(ci),
    };
    return { h, delivered, decisions, store };
  };
  const options = () => ({ repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 24 * H, stallMs: 1e12, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: rulesFor() });

  it('drops a held failure once a newer run of the same workflow on the same branch completes, and keeps other workflows', async () => {
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      runs: script(changed([]), changed([brun(1, 'docs', 'scratch', 'failure', 's100000')], 'r2'), changed([brun(1, 'docs', 'scratch', 'failure', 's100000'), brun(2, 'docs', 'scratch', 'success', 's200000'), brun(3, 'lint', 'scratch', 'failure', 's200000')], 'r3')),
    });
    const clock = { now: 1_000_000 };
    const { h, delivered, decisions } = host(forge, clock);
    const watcher = new Watcher(h, options());
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    expect(watcher.snapshot().deferred.map((d) => d.event.id)).toEqual(['ci#1']);
    await watcher.tick();
    expect(delivered).toHaveLength(0);
    expect(decisions).toContain('drop ci#1 superseded by run 2');
    expect(watcher.snapshot().deferred.map((d) => d.event.id)).toEqual(['ci#2', 'ci#3']);
  });

  it('delivers only the green run when a failure and a newer green run of one workflow land in the same poll', async () => {
    const both = () =>
      fakeForge({
        login: async () => 'me',
        items: script(changed([slim(1)])),
        runs: script(changed([]), changed([brun(1, 'docs', 'dev', 'failure', 'd100000'), brun(2, 'docs', 'dev', 'success', 'd200000')], 'r2')),
      });
    const all = host(both(), { now: 1_000_000 }, new Map(), 'all');
    const w1 = new Watcher(all.h, options());
    await w1.start();
    await w1.tick();
    await w1.tick();
    expect(all.delivered).toHaveLength(1);
    expect(all.delivered[0]).not.toContain('ci failure');
    expect(all.delivered[0]!.split('\n')[1]).toBe('ci success: docs on dev @d200000 (push) · now: dev @d200000, docs success');

    // under ci: failures the failure on the protected branch is dropped and the green run is held: nothing is delivered
    const failures = host(both(), { now: 1_000_000 });
    const w2 = new Watcher(failures.h, options());
    await w2.start();
    await w2.tick();
    await w2.tick();
    expect(failures.delivered).toHaveLength(0);
    expect(failures.decisions).toContain('drop ci#1 superseded by run 2');
    expect(w2.snapshot().deferred.map((d) => d.event.id)).toEqual(['ci#2']);
  });

  it('drops the runs held for an older pr head when the new head settles', async () => {
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      runs: script(changed([]), changed([run(10, 'build', true, 'failure', 'aaa1234')], 'r2'), changed([run(10, 'build', true, 'failure', 'aaa1234'), run(11, 'build', true, 'success', 'bbb1234')], 'r3')),
      pulls: script(changed([pr3('aaa1234')]), same(), changed([pr3('bbb1234')], 'p3')),
      checks: async (_r, at) => (at === 'aaa1234' ? [check('build', true, 'failure'), ext(false)] : [check('build', true), ext(true)]),
    });
    const { h, delivered, decisions } = host(forge, { now: 1_000_000 });
    const watcher = new Watcher(h, options());
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    expect(watcher.snapshot().deferred.map((d) => d.reason)).toEqual(['ci failure on pr #3, awaiting the other checks']);
    await watcher.tick();
    expect(decisions).toContain('drop ci#10 superseded by the settled verdict on pr #3 @bbb1234');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.split('\n')[1]).toBe('ci settled success: pr #3 feat/3 @bbb1234: Feat 3 (2 checks) · now: open, head unchanged');
    expect(delivered[0]).not.toContain('deferred meanwhile');
  });

  it('drops a held run on a pr head that has since moved when it ages out, rather than delivering it', async () => {
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      runs: script(changed([]), changed([run(10, 'build', true, 'failure', 'aaa1234')], 'r2')),
      pulls: script(changed([pr3('aaa1234')]), same(), changed([pr3('bbb1234')], 'p3')),
      checks: async (_r, at) => (at === 'aaa1234' ? [check('build', true, 'failure'), ext(false)] : [ext(false)]),
    });
    const clock = { now: 1_000_000 };
    const { h, delivered, decisions } = host(forge, clock);
    const watcher = new Watcher(h, options());
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    clock.now += 25 * H;
    await watcher.tick();
    expect(delivered).toHaveLength(0);
    expect(decisions).toContain('drop ci#10 superseded by head @bbb1234');
    expect(watcher.snapshot().deferred).toEqual([]);
  });

  it('reads each aged-out subject again: a newer run on the branch drops it, a head that settled meanwhile delivers its verdict, the rest carry their current state', async () => {
    let extDone = false;
    const branchReads: string[] = [];
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      // tick 2: a docs failure on scratch, a docs success on other, and a build on the head of pr 3 whose external check is still running
      runs: script(changed([]), changed([brun(5, 'docs', 'scratch', 'failure', 's500000'), brun(6, 'docs', 'other', 'success', 'o600000'), brun(10, 'build', 'feat/3', 'success', 'abc1234def')], 'r2')),
      pulls: script(changed([pr3('abc1234def')]), same(), same()),
      checks: async () => [check('build', true), ext(extDone)],
      // the listing the poll holds never saw run 7: only the per-branch read does
      branchRuns: async (_r, branch) => {
        branchReads.push(branch);
        return branch === 'scratch' ? [brun(7, 'docs', 'scratch', 'success', 's700000'), brun(5, 'docs', 'scratch', 'failure', 's500000')] : [brun(6, 'docs', 'other', 'success', 'o600000')];
      },
    });
    const clock = { now: 1_000_000 };
    const { h, delivered, decisions } = host(forge, clock);
    const watcher = new Watcher(h, options());
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    expect(watcher.snapshot().deferred.map((d) => d.event.id)).toEqual(['ci#5', 'ci#6', 'ci#10']);
    extDone = true;
    clock.now += 25 * H;
    await watcher.tick();
    expect(branchReads.sort()).toEqual(['other', 'scratch']);
    expect(decisions).toContain('drop ci#5 superseded by run 7');
    expect(decisions).toContain('drop ci#10 superseded by the settled verdict on pr #3 @abc1234');
    expect(delivered).toHaveLength(1);
    const lines = delivered[0]!.split('\n');
    expect(lines).toContain('ci success: docs on other @o600000 (push) · now: other @o600000, docs success');
    expect(lines).toContain('  by me · https://x/runs/6 · deferred ci success, aged out · s1');
    expect(lines).toContain('ci settled success: pr #3 feat/3 @abc1234: Feat 3 (2 checks) · now: open, head unchanged');
    expect(delivered[0]).not.toContain('scratch');
    expect(watcher.snapshot().deferred).toEqual([]);
  });

  it('delivers only what is not superseded from a persisted backlog restored hours later', async () => {
    const store = new Map<string, unknown>();
    const first = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      runs: script(changed([]), changed([brun(5, 'docs', 'scratch', 'failure', 's500000'), brun(6, 'docs', 'other', 'success', 'o600000'), run(10, 'build', true, 'failure', 'aaa1234')], 'r2')),
      pulls: script(changed([pr3('aaa1234')]), same()),
      checks: async () => [check('build', true, 'failure'), ext(false)],
    });
    const clock = { now: 1_000_000 };
    const before = host(first, clock, store);
    const w1 = new Watcher(before.h, options());
    await w1.start();
    await w1.tick();
    await w1.tick();
    w1.stop();
    expect(before.delivered).toHaveLength(0);
    expect(w1.snapshot().deferred).toHaveLength(3);

    // the session comes back 30 hours later: scratch went green, pr 3 moved to a new head whose checks are still running
    clock.now += 30 * H;
    const later = fakeForge({
      login: async () => 'me',
      items: script(same()),
      runs: script(changed([brun(7, 'docs', 'scratch', 'success', 's700000'), brun(5, 'docs', 'scratch', 'failure', 's500000'), brun(6, 'docs', 'other', 'success', 'o600000'), run(10, 'build', true, 'failure', 'aaa1234')], 'r9')),
      pulls: script(changed([pr3('bbb1234')], 'p9')),
      checks: async () => [ext(false)],
      branchRuns: async () => [brun(6, 'docs', 'other', 'success', 'o600000')],
    });
    const after = host(later, clock, store);
    const w2 = new Watcher(after.h, options());
    await w2.start();
    await w2.tick();
    expect(after.decisions).toContain('drop ci#5 superseded by run 7');
    expect(after.decisions).toContain('drop ci#10 superseded by head @bbb1234');
    expect(after.delivered).toHaveLength(1);
    const lines = after.delivered[0]!.split('\n');
    expect(lines.filter((l) => l.startsWith('ci '))).toEqual(['ci success: docs on other @o600000 (push) · now: other @o600000, docs success']);
    // the green run on scratch is fresh news, held as ci success rather than aged out
    expect(w2.snapshot().deferred.map((d) => d.event.id)).toEqual(['ci#7']);
  });

  it('states where the subject stands now: a pr open with its head unchanged or moved, merged, closed, or a branch\'s newest run', () => {
    const state = {
      ...initialState(),
      pulls: [pr3('bbb1234')],
      items: { '4': { kind: 'pr' as const, title: 't', state: 'closed', user: 'u', bot: false, bodySig: '', created: '', comments: 0, labels: '', updated: '', merged: true, url: '' }, '5': { kind: 'pr' as const, title: 't', state: 'closed', user: 'u', bot: false, bodySig: '', created: '', comments: 0, labels: '', updated: '', merged: false, url: '' } },
      runs: { '1': brun(1, 'docs', 'dev', 'failure', 'd100000'), '2': brun(2, 'docs', 'dev', 'success', 'd200000'), '3': brun(3, 'lint', 'dev', 'failure', 'd300000') },
      heads: recordHeads({}, [pr3('aaa1234'), pr3('bbb1234')]),
    };
    const ci = (over: Partial<WatchEvent>): WatchEvent => event({ kind: 'ci', ...over });
    expect(currentState(ci({ subject: 'pr:3', sha: 'bbb1234' }), state)).toBe('open, head unchanged');
    expect(currentState(ci({ subject: 'pr:3', sha: 'aaa1234' }), state)).toBe('open, head @bbb1234 (moved)');
    expect(currentState(ci({ subject: 'pr:4', sha: 'x' }), state)).toBe('merged');
    expect(currentState(ci({ subject: 'pr:5', sha: 'x' }), state)).toBe('closed');
    expect(currentState(ci({ subject: 'pr:6', sha: 'x' }), state)).toBe('not open');
    expect(currentState(ci({ subject: 'branch:dev', branch: 'dev', sha: 'd100000', run: '1', workflow: 'docs', conclusion: 'failure' }), state)).toBe('dev @d200000, docs success');
    expect(currentState(ci({ subject: 'branch:dev', branch: 'dev', sha: 'd300000', run: '3', workflow: 'lint', conclusion: 'failure' }), state)).toBe('dev @d300000, lint failure');
    // a run on a past head of a pr keys to the pr, anything else to its branch
    expect(runSubject({ sha: 'aaa1234', branch: 'feat/3' }, state.heads)).toBe('pr:3');
    expect(runSubject({ sha: 'zzz', branch: 'dev' }, state.heads)).toBe('branch:dev');
    expect(newerRun(Object.values(state.runs), (r) => r.name === 'docs', '1')?.id).toBe('2');
    expect(newerRun(Object.values(state.runs), (r) => r.name === 'docs', '2')).toBeUndefined();
  });
});

describe('subscriptions', () => {
  const offJudge = { name: 'fake', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'fake' }) } as Judge;
  const brun = (id: number, name: string, branch: string, conclusion: string | null, sha: string, over: Partial<Run> = {}): Run => ({ id: String(id), name, branch, tag: false, event: 'push', done: conclusion !== null, conclusion, ok: conclusion === 'success', sha, url: `https://x/runs/${id}`, actor: 'me', updatedAt: '1', ...over });
  const filter = { items: true, ci: 'failures' as const, stall: true };
  const noTriage = { ignoreSelf: true, ignoreBots: true, triage: false, protectedBranches: ['main'] };
  const options = { minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: noTriage };

  // tick 1 seeds with pr 3 open and its check running. tick 2: a comment on issue 2, pr 3 opened as an item, the
  // build on pr 3's head (its checks then settle), a docs failure on dev, a release run on the tag v1.2.0 and a docs failure on scratch
  const scenario = () => {
    let done = false;
    return fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1), slim(2)]), changed([slim(2, { comments: 1, updatedAt: '2026-01-05T00:00:00Z' }), slim(3, { kind: 'pr', createdAt: '2026-01-09T00:00:00Z', updatedAt: '2026-01-09T00:00:00Z' })], 'f')),
      runs: script(changed([]), () => {
        done = true;
        return changed([run(10, 'build', true, 'success'), brun(20, 'docs', 'dev', 'failure', 'd200000'), brun(30, 'release', 'v1.2.0', 'success', 't300000', { tag: true }), brun(40, 'docs', 'scratch', 'failure', 's400000')], 'r2');
      }),
      pulls: script(changed([pull()]), same()),
      checks: async () => [check('build', done)],
    });
  };

  // what reaches the subscriptions given, over the scenario: the url of each delivered event and each delivery
  async function deliveredFor(subs: Subscription[]) {
    const deliveries: WatchDelivery[] = [];
    const watcher = new Watcher(
      { forge: scenario(), store: memoryStore(), judge: offJudge, pack: BUILTIN_PACKS['triage']!, config: DEFAULT_CONFIG, now: () => 1_000_000, deliver: async (d) => void deliveries.push(d), log: () => {}, status: () => {}, schedule: () => ({ cancel: () => {} }), subscriptions: () => subs },
      { repo: 'o/r', ...options },
    );
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    const urls = deliveries.flatMap((d) => d.text.split('\n').filter((l) => l.startsWith('  by ')).map((l) => l.split(' · ')[1]!));
    return { urls, deliveries };
  }

  it('delivers everything in the repository to a repo subscription', async () => {
    const { urls } = await deliveredFor([sub('s1', { kind: 'repo' }, 'all')]);
    expect(urls.sort()).toEqual(['https://x/2', 'https://x/3', 'https://x/pull/3', 'https://x/runs/10', 'https://x/runs/20', 'https://x/runs/30', 'https://x/runs/40']);
  });

  it('delivers only its pull request\'s item events, runs and verdict to a pr subscription', async () => {
    const { urls } = await deliveredFor([sub('s1', { kind: 'pr', number: 3 }, 'all')]);
    expect(urls.sort()).toEqual(['https://x/3', 'https://x/pull/3', 'https://x/runs/10']);
    const settled = await deliveredFor([sub('s1', { kind: 'pr', number: 3 }, 'settled')]);
    expect(settled.urls.sort()).toEqual(['https://x/3', 'https://x/pull/3']);
  });

  it('delivers only the runs of its branch to a branch subscription, not a tag of another name', async () => {
    const { urls } = await deliveredFor([sub('s1', { kind: 'branch', name: 'dev' }, 'all')]);
    expect(urls).toEqual(['https://x/runs/20']);
    expect((await deliveredFor([sub('s1', { kind: 'branch', name: 'v1.2.0' }, 'all')])).urls).toEqual([]);
  });

  it('delivers only its run to a run subscription', async () => {
    const { urls } = await deliveredFor([sub('s1', { kind: 'run', id: '40' }, 'failures')]);
    expect(urls).toEqual(['https://x/runs/40']);
  });

  it('delivers only runs on tags matching its glob to a tag subscription, success included under settled', async () => {
    const { urls } = await deliveredFor([sub('s1', { kind: 'tag', glob: 'v1.*' }, 'settled')]);
    expect(urls).toEqual(['https://x/runs/30']);
    expect((await deliveredFor([sub('s1', { kind: 'tag', glob: 'v2.*' }, 'all')])).urls).toEqual([]);
  });

  it('delivers an event several subscriptions match once, naming each and the agents they belong to', async () => {
    const subs = [sub('s1', { kind: 'pr', number: 3 }, 'settled', { for: 'issue-3' }), sub('s2', { kind: 'repo' }, 'failures'), sub('s3', { kind: 'branch', name: 'feat/3' }, 'failures', { for: 'lead' })];
    const { deliveries } = await deliveredFor(subs);
    expect(deliveries).toHaveLength(1);
    const lines = deliveries[0]!.text.split('\n');
    expect(lines[0]).toBe('[sift watch o/r]');
    expect(lines).toContain('for issue-3, lead: ci settled success: pr #3 feat/3 @abc1234: Feat 3 (1 checks) · now: open, head unchanged');
    expect(lines).toContain('  by me · https://x/pull/3 · ci settled on pr · s1, s2, s3');
    expect(lines.filter((l) => l.includes('https://x/pull/3'))).toHaveLength(1);
    expect(deliveries[0]!.subscriptions.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3']);
    // one agent's subscriptions alone: the header names it
    const own = await deliveredFor([sub('s1', { kind: 'pr', number: 3 }, 'settled', { for: 'issue-3' })]);
    expect(own.deliveries[0]!.text.split('\n')[0]).toBe('[sift watch o/r for issue-3]');
  });

  const registry = (forge: ReturnType<typeof fakeForge>, agents: AgentLike[] = [], clock = { now: 1_000_000 }, store = memoryStore()) => {
    const delivered: WatchDelivery[] = [];
    const logs: string[] = [];
    const host: WatchesHost = {
      store,
      key: 'watch-subs:test',
      agents: async () => agents,
      now: () => clock.now,
      log: (t) => void logs.push(t),
      status: () => {},
      watcher: { forge, store, judge: offJudge, pack: BUILTIN_PACKS['triage']!, config: DEFAULT_CONFIG, now: () => clock.now, deliver: async (d) => void delivered.push(d), log: () => {}, schedule: () => ({ cancel: () => {} }) },
      options,
    };
    return { w: new Watches(host), delivered, logs, store };
  };

  it('starts a poller for each repository subscribed, shares it between subscriptions, and stops it with the last', async () => {
    let reads = 0;
    const forge = fakeForge({ items: async () => (reads++, { changed: false, rate: {} }) });
    const agents = [{ id: 'a1', name: 'issue-3', status: 'running' }];
    const { w, store } = registry(forge, agents);
    // a subscribe naming another repository than the session's
    const asked = subscriptionOf({ repo: 'o/other' }, { start: false, repo: 'o/r', filter });
    expect(asked).toEqual({ repo: 'o/other', scope: { kind: 'repo' }, filter });
    const other = await w.subscribe(asked as Omit<Subscription, 'id'>);
    expect(w.poller('o/other')).toBeDefined();
    const pr = await w.subscribe({ repo: 'o/r', scope: { kind: 'pr', number: 3 }, filter, for: 'issue-3', until: 'merged' });
    const poller = w.poller('o/r')!;
    const tag = await w.subscribe({ repo: 'o/r', scope: { kind: 'tag', glob: 'v*' }, filter: { ...filter, ci: 'settled' } });
    expect(w.poller('o/r')).toBe(poller);
    expect(w.repos()).toEqual(['o/other', 'o/r']);
    expect(w.list().map(formatSubscription)).toEqual(['s1 o/other repo · items, ci failures, stall', 's2 o/r pr 3 · items, ci failures, stall · for issue-3 · until merged', 's3 o/r tag v* · items, ci settled, stall']);
    // the same subscription again is the one already there
    expect(await w.subscribe({ repo: 'o/other', scope: { kind: 'repo' }, filter })).toEqual({ sub: other.sub, added: false });
    await w.unsubscribe(pr.sub.id);
    expect(w.poller('o/r')).toBe(poller);
    await poller.tick();
    await w.unsubscribe(tag.sub.id);
    expect(w.poller('o/r')).toBeUndefined();
    const before = reads;
    await poller.tick();
    expect(reads).toBe(before);
    // a resumed session restores its subscriptions and their pollers
    const again = registry(forge, agents, { now: 1_000_000 }, store);
    await again.w.load();
    expect(again.w.list()).toEqual([other.sub]);
    expect(again.w.poller('o/other')).toBeDefined();
    expect(await again.w.subscribe({ repo: 'o/r', scope: { kind: 'repo' }, filter })).toMatchObject({ sub: { id: 's4' } });
  });

  it('delivers a run subscription\'s completion read by id when 30 newer runs have paged it out of the listing', async () => {
    const reads: string[] = [];
    let done = false;
    const newer = Array.from({ length: 30 }, (_, i) => brun(100 + i, 'ci', 'dev', i % 2 ? null : 'success', `d${i}000000`));
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(1)])),
      runs: script(changed(newer), same(), same()),
      run: async (_r, id) => (reads.push(id), brun(5, 'release', 'main', done ? 'failure' : null, 'm500000')),
    });
    const { w, delivered } = registry(forge);
    await w.subscribe({ repo: 'o/r', scope: { kind: 'run', id: '5' }, filter: { ...filter, ci: 'settled' }, until: 'settled' });
    await w.subscribe({ repo: 'o/r', scope: { kind: 'repo' }, filter });
    const poller = w.poller('o/r')!;
    await poller.tick();
    expect(delivered).toHaveLength(0);
    done = true;
    await poller.tick();
    expect(reads).toEqual(['5', '5']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text.split('\n').slice(1, 3)).toEqual(['ci failure: release on main @m500000 (push) · now: main @m500000, release failure', '  by me · https://x/runs/5 · ci run completed · s1, s2']);
    // until settled: the delivery used it up, and the run is read no more
    expect(w.list().map((s) => s.id)).toEqual(['s2']);
    await poller.tick();
    expect(reads).toEqual(['5', '5']);
    expect(delivered).toHaveLength(1);
  });

  it('delivers a run that completed before it was subscribed to, on the seed poll', async () => {
    const forge = fakeForge({ login: async () => 'me', runs: script(changed([brun(7, 'release', 'main', 'success', 'm700000')])) });
    const { w, delivered } = registry(forge);
    await w.subscribe({ repo: 'o/r', scope: { kind: 'run', id: '7' }, filter });
    await w.poller('o/r')!.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain('ci success: release on main @m700000');
  });

  it('removes an until: settled pr subscription after its verdict, an until: merged one once merged, and an until time once passed', async () => {
    let done = false;
    const forge = fakeForge({
      login: async () => 'me',
      items: script(changed([slim(3, { kind: 'pr' })]), same(), changed([slim(3, { kind: 'pr', state: 'closed', merged: true, updatedAt: '2026-01-09T00:00:00Z' })], 'f')),
      runs: script(changed([]), () => {
        done = true;
        return changed([run(10, 'build', true, 'success')], 'r2');
      }),
      pulls: script(changed([pull()]), same(), changed([], 'p3')),
      checks: async () => [check('build', done)],
    });
    const clock = { now: 1_000_000 };
    const { w, delivered, logs } = registry(forge, [], clock);
    await w.subscribe({ repo: 'o/r', scope: { kind: 'pr', number: 3 }, filter, until: 'settled' });
    await w.subscribe({ repo: 'o/r', scope: { kind: 'pr', number: 3 }, filter: { ...filter, ci: 'none' }, until: 'merged' });
    await w.subscribe({ repo: 'o/r', scope: { kind: 'repo' }, filter: { ...filter, items: false }, until: new Date(clock.now + 60_000).toISOString() });
    const poller = w.poller('o/r')!;
    await poller.tick();
    await poller.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.subscriptions.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(w.list().map((s) => s.id)).toEqual(['s2', 's3']);
    clock.now += 120_000;
    await poller.tick();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.text).toContain('pr #3 state open->closed, merged: Issue 3');
    expect(delivered[1]!.subscriptions.map((s) => s.id)).toEqual(['s2']);
    expect(w.list()).toEqual([]);
    expect(w.poller('o/r')).toBeUndefined();
    expect(logs).toEqual(['sift watch: s1 on o/r pr 3 removed, until settled reached', 'sift watch: s3 on o/r repo removed, until reached', 'sift watch: s2 on o/r pr 3 removed, until reached']);
  });

  it('removes an agent\'s subscriptions once the agent finishes, before the next poll delivers anything', async () => {
    const agents = [{ id: 'a1', name: 'issue-3', status: 'running' }, { id: 'a2', status: 'running' }];
    let polls = 0;
    const forge = fakeForge({ items: async () => (polls++, { changed: false, rate: {} }) });
    const { w, logs } = registry(forge, agents);
    await w.subscribe({ repo: 'o/r', scope: { kind: 'pr', number: 3 }, filter, for: 'issue-3' });
    await w.subscribe({ repo: 'o/r', scope: { kind: 'branch', name: 'dev' }, filter, for: 'a2' });
    const poller = w.poller('o/r')!;
    await poller.tick();
    expect(w.list()).toHaveLength(2);
    agents[0]!.status = 'completed';
    await poller.tick();
    expect(w.list().map((s) => s.for)).toEqual(['a2']);
    expect(logs).toEqual(['sift watch: s1 on o/r pr 3 removed, its agent finished']);
    // an agent the session no longer lists has finished too, and the poller goes with its last subscription
    agents.pop();
    const before = polls;
    await poller.tick();
    expect(w.list()).toEqual([]);
    expect(w.poller('o/r')).toBeUndefined();
    expect(polls).toBe(before);
  });

  it('holds every poller on one token once any of them reads the rate floor', async () => {
    const rate = { until: 0 };
    const waits: number[] = [];
    const low = fakeForge({ items: async () => ({ changed: false, rate: { remaining: 3, reset: 1_600 } }) });
    const fine = fakeForge({ items: async () => ({ changed: false, rate: { remaining: 4000 } }) });
    const make = (forge: ReturnType<typeof fakeForge>) =>
      new Watcher({ forge, store: memoryStore(), judge: offJudge, pack: BUILTIN_PACKS['triage']!, config: DEFAULT_CONFIG, now: () => 1_000_000, deliver: async () => {}, log: () => {}, status: () => {}, schedule: (ms) => (waits.push(ms), { cancel: () => {} }), subscriptions: () => repoSub(), rate }, { repo: 'o/r', ...options });
    const a = make(low);
    await a.start();
    await a.tick();
    expect(rate.until).toBe(1_605_000);
    const b = make(fine);
    await b.start();
    await b.tick();
    expect(waits).toEqual([605_000, 605_000]);
  });

  it('reseeds a store written before subscriptions', async () => {
    expect(STATE_VERSION).toBe(9);
    const store = memoryStore(new Map([['watch:o/r', { ...initialState(), version: 8, seeded: true, armedBy: 'issue-1' }]]));
    const logs: string[] = [];
    const watcher = new Watcher({ forge: fakeForge(), store, judge: offJudge, pack: BUILTIN_PACKS['triage']!, config: DEFAULT_CONFIG, now: () => 1_000_000, deliver: async () => {}, log: (t) => void logs.push(t), status: () => {}, schedule: () => ({ cancel: () => {} }), subscriptions: () => repoSub() }, { repo: 'o/r', ...options });
    await watcher.start();
    expect(logs[0]).toBe('sift watch o/r: stored state is from an older version, reseeding');
    expect(watcher.snapshot()).not.toHaveProperty('armedBy');
  });
});
