import { describe, expect, it } from 'vitest';
import type { Check, Conditional, Run, WatchItem } from '../src/forge/forge.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/repo/config.ts';
import type { Judge, Questions } from '../src/judge/types.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { armedAgent, deliveryAgent, diffItems, diffRuns, hashOf, pendingChecks, settleChecks, toItem, type Item, type WatchEvent } from '../src/watch/poll.ts';
import { routeByRules, type WatchRules } from '../src/watch/triage.ts';
import { armedNotice, armingAgent, armRef, Watcher, summarize, type WatchHost } from '../src/watch/watcher.ts';
import { fakeForge } from './fake-forge.ts';

const rules: WatchRules = { ignoreSelf: true, ignoreBots: true, ci: 'failures', triage: true, login: 'me', protectedBranches: ['main', 'dev'], branchPattern: '^(feat|fix)/\\d+$' };

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
    const run: Run = { id: '1', name: 'ci', branch: 'main', event: 'push', done: true, conclusion: 'failure', ok: false, sha: 'abc', url: 'u', actor: 'a', updatedAt: '1' };
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
  it('settles ci without the judge', () => {
    expect(routeByRules(event({ kind: 'ci', conclusion: 'success', ok: true, branch: 'feat/12', settled: true }), rules).action).toBe('deliver');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'success', ok: true, branch: 'feat/12', settled: true }), { ...rules, ci: 'none' }).action).toBe('drop');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'failure', branch: 'main' }), rules).action).toBe('deliver');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'failure', branch: 'feat/12' }), rules).action).toBe('deliver');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'failure', branch: 'scratch' }), rules).action).toBe('defer');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'success', ok: true, branch: 'main' }), rules).action).toBe('defer');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'success', ok: true }), { ...rules, ci: 'all' }).action).toBe('deliver');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'failure' }), { ...rules, ci: 'none' }).action).toBe('drop');
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
const run = (id: number, name: string, done: boolean, conclusion: string | null, sha = 'abc1234def'): Run => ({ id: String(id), name, branch: 'feat/3', event: 'push', done, conclusion, ok: conclusion === 'success', sha, url: `https://x/runs/${id}`, actor: 'me', updatedAt: '1' });
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
        deliver: async (t) => void delivered.push(t),
        log: () => {},
        status: () => {},
        schedule: (_ms, fn) => {
          scheduled.push(fn);
          return { cancel: () => {} };
        },
      },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: { ignoreSelf: false, ignoreBots: true, ci: 'failures', triage: true, protectedBranches: ['main'] } },
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
    expect(summarize([{ event: event({}), reason: 'a' }, { event: event({}), reason: 'a' }])).toBe('2 a');
  });

  const silent = (over: Partial<WatchHost> = {}) => ({
    store: { get: async () => undefined, set: async () => {} },
    judge: { name: 'fake', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'fake' }) } as Judge,
    pack: BUILTIN_PACKS['triage']!,
    config: DEFAULT_CONFIG,
    log: () => {},
    status: () => {},
    schedule: () => ({ cancel: () => {} }),
    ...over,
  });
  const ciRules = { ignoreSelf: true, ignoreBots: true, ci: 'failures' as const, triage: false, protectedBranches: ['main'], branchPattern: '^feat/\\d+$' };

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
      { forge, ...silent(), now: () => 1_000_000, deliver: async (t) => void delivered.push(t), onDecision: (e, action, label) => decisions.push(`${action} ${e.id} ${label}`) },
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
      { forge, ...silent({ judge, ciPack: BUILTIN_PACKS['ci']! }), now: () => 1_000_000, deliver: async (t) => void delivered.push(t) },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: ciRules },
    );
    await watcher.start();
    await watcher.tick();
    await watcher.tick();
    expect(delivered).toHaveLength(1);
    const lines = delivered[0]!.split('\n');
    expect(lines[1]).toBe('ci settled failure: pr #3 feat/3 @abc1234: Feat 3 (3 checks, failed: test, ext) · now: open, head unchanged');
    expect(lines[2]).toBe('  by me · https://x/pull/3 · ci settled on pr');
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
      { forge, ...silent(), now: () => now, deliver: async (t) => void delivered.push(t) },
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
      { forge, ...silent(), now: () => now, deliver: async (t) => void delivered.push(t) },
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
      { forge, ...silent(), now: () => now, deliver: async (t) => void delivered.push(t) },
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

  it('names the subagent that armed the watch on every delivery, and nothing when the main loop did', async () => {
    const settledForge = () => {
      let test = false;
      return fakeForge({
        login: async () => 'me',
        items: script(changed([slim(1)])),
        // tick 1: seed with the pr open and its checks running. tick 2: both finished
        runs: script(changed([run(10, 'build', false, null), run(11, 'test', false, null)]), () => {
          test = true;
          return changed([run(10, 'build', true, 'success'), run(11, 'test', true, 'success')], 'r2');
        }),
        pulls: script(changed([pull()]), same()),
        checks: async () => [check('build', true), check('test', test)],
      });
    };
    const options = { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: ciRules };
    const store = new Map<string, unknown>();
    const delivered: string[] = [];
    const armed = new Watcher({ forge: settledForge(), ...silent({ store: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) } }), now: () => 1_000_000, deliver: async (t) => void delivered.push(t) }, options);
    await armed.start();
    await armed.arm('issue-113');
    expect((store.get('watch:o/r') as { armedBy?: string }).armedBy).toBe('issue-113');
    await armed.tick();
    await armed.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.split('\n')[0]).toBe('[sift watch o/r for issue-113]');
    expect(delivered[0]).toContain('ci settled success: pr #3 feat/3 @abc1234: Feat 3 (2 checks)');

    delivered.length = 0;
    const main = new Watcher({ forge: settledForge(), ...silent(), now: () => 1_000_000, deliver: async (t) => void delivered.push(t) }, options);
    await main.start();
    await main.arm(undefined);
    await main.tick();
    await main.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.split('\n')[0]).toBe('[sift watch o/r]');
  });

  it('names the agent armed for a pr on its ci verdict line, and no agent on a verdict none is armed for', async () => {
    const options = { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: ciRules };
    // two prs, 3 on feat/3 and 4 on feat/4, whose checks all finish in the second tick
    const twoPulls = () => {
      let done = false;
      return fakeForge({
        login: async () => 'me',
        items: script(changed([slim(1)])),
        runs: script(changed([run(10, 'build', false, null), run(20, 'build', false, null, 'def5678abc')]), () => {
          done = true;
          return changed([run(10, 'build', true, 'success'), run(20, 'build', true, 'failure', 'def5678abc')], 'r2');
        }),
        pulls: script(changed([pull(), { number: 4, title: 'Feat 4', branch: 'feat/4', sha: 'def5678abc', url: 'https://x/pull/4', user: 'bob' }]), same()),
        checks: async (_r, sha) => [check('build', done, done ? (sha === 'def5678abc' ? 'failure' : 'success') : null)],
      });
    };
    const armed = async (arms: [string | undefined, string | undefined][]) => {
      const store = new Map<string, unknown>();
      const delivered: string[] = [];
      const watcher = new Watcher({ forge: twoPulls(), ...silent({ store: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) } }), now: () => 1_000_000, deliver: async (t) => void delivered.push(t) }, options);
      await watcher.start();
      for (const [by, ref] of arms) await watcher.arm(by, ref);
      await watcher.tick();
      await watcher.tick();
      expect(delivered).toHaveLength(1);
      return { lines: delivered[0]!.split('\n'), state: store.get('watch:o/r') as { armedBy?: string; armedFor?: { agent: string; ref: string }[] } };
    };

    // a match by pr number
    let out = await armed([['issue-3', '3']]);
    expect(out.state.armedFor).toEqual([{ agent: 'issue-3', ref: '3' }]);
    expect(out.lines).toContain('for issue-3: ci settled success: pr #3 feat/3 @abc1234: Feat 3 (1 checks) · now: open, head unchanged');
    // pr 4 matches no entry of a non-empty set and names no agent, on its line or in the header
    expect(out.lines).toContain('ci settled failure: pr #4 feat/4 @def5678: Feat 4 (1 checks, failed: build) · now: open, head unchanged');
    expect(out.lines[0]).toBe('[sift watch o/r]');

    // a miss: armed for a pr that is not settling, neither line nor the header names the stale agent
    out = await armed([['issue-9', '9']]);
    expect(out.lines[0]).toBe('[sift watch o/r]');
    expect(out.lines.filter((l) => l.startsWith('ci settled'))).toHaveLength(2);
    expect(out.lines.some((l) => l.includes('issue-9'))).toBe(false);

    // an empty set: armed without a ref, every verdict and the header fall back to the last armer
    out = await armed([['issue-5', undefined]]);
    expect(out.state.armedFor).toBeUndefined();
    expect(out.lines[0]).toBe('[sift watch o/r for issue-5]');
    expect(out.lines).toContain('for issue-5: ci settled success: pr #3 feat/3 @abc1234: Feat 3 (1 checks) · now: open, head unchanged');
    expect(out.lines).toContain('for issue-5: ci settled failure: pr #4 feat/4 @def5678: Feat 4 (1 checks, failed: build) · now: open, head unchanged');

    // two agents on two prs in one poll, one by number and one by head branch, each line names its own agent
    out = await armed([['issue-3', '3'], ['issue-4', 'feat/4'], ['issue-4', 'feat/4']]);
    expect(out.state.armedBy).toBe('issue-4');
    expect(out.state.armedFor).toEqual([{ agent: 'issue-3', ref: '3' }, { agent: 'issue-4', ref: 'feat/4' }]);
    expect(out.lines[0]).toBe('[sift watch o/r for issue-4]');
    expect(out.lines).toContain('for issue-3: ci settled success: pr #3 feat/3 @abc1234: Feat 3 (1 checks) · now: open, head unchanged');
    expect(out.lines).toContain('for issue-4: ci settled failure: pr #4 feat/4 @def5678: Feat 4 (1 checks, failed: build) · now: open, head unchanged');

    // a leading # on a pr number is stripped when the ref is stored, so #3 names pr 3
    out = await armed([['issue-3', '#3']]);
    expect(out.state.armedFor).toEqual([{ agent: 'issue-3', ref: '3' }]);
    expect(out.lines).toContain('for issue-3: ci settled success: pr #3 feat/3 @abc1234: Feat 3 (1 checks) · now: open, head unchanged');
    expect(armRef('#3')).toBe('3');
    expect(armRef('3')).toBe('3');
    expect(armRef('feat/3')).toBe('feat/3');
    expect(armRef('#feat/3')).toBe('#feat/3');

    // one ref names one agent: a later arm for the same pr replaces the entry, the newest wins
    out = await armed([['issue-3', '3'], ['issue-3b', '#3']]);
    expect(out.state.armedFor).toEqual([{ agent: 'issue-3b', ref: '3' }]);
    expect(out.lines).toContain('for issue-3b: ci settled success: pr #3 feat/3 @abc1234: Feat 3 (1 checks) · now: open, head unchanged');
    expect(out.lines).not.toContain('for issue-3: ci settled success: pr #3 feat/3 @abc1234: Feat 3 (1 checks) · now: open, head unchanged');

    // a start without a ref keeps the set and replaces the name, which an unmatched verdict still does not take
    out = await armed([['issue-3', '3'], ['issue-5', undefined]]);
    expect(out.state.armedBy).toBe('issue-5');
    expect(out.state.armedFor).toEqual([{ agent: 'issue-3', ref: '3' }]);
    expect(out.lines[0]).toBe('[sift watch o/r]');
    expect(out.lines).toContain('for issue-3: ci settled success: pr #3 feat/3 @abc1234: Feat 3 (1 checks) · now: open, head unchanged');
    expect(out.lines).toContain('ci settled failure: pr #4 feat/4 @def5678: Feat 4 (1 checks, failed: build) · now: open, head unchanged');
    // a main-loop start clears both
    out = await armed([['issue-3', '3'], [undefined, undefined]]);
    expect(out.state.armedBy).toBeUndefined();
    expect(out.state.armedFor).toBeUndefined();
    expect(out.lines[0]).toBe('[sift watch o/r]');
    expect(out.lines).toContain('ci settled success: pr #3 feat/3 @abc1234: Feat 3 (1 checks) · now: open, head unchanged');
  });

  it('keeps the last armer on a delivery of non-ci events whatever the set holds, and drops it for an unmatched ci event', () => {
    const base = { id: 'x', title: 't', user: 'u', bot: false, url: 'https://x', changes: [], at: 0, isNew: true };
    const issue: WatchEvent = { ...base, kind: 'issue', number: 7 };
    const verdict = (number: number, branch: string): WatchEvent => ({ ...base, kind: 'ci', number, branch, settled: true, conclusion: 'success', ok: true });
    const run: WatchEvent = { ...base, kind: 'ci', branch: 'dev', conclusion: 'success', ok: true };
    const set = { armedBy: 'issue-9', armedFor: [{ agent: 'issue-3', ref: '3' }] };
    const empty = { armedBy: 'issue-9' };

    expect(armedAgent(issue, set)).toBeUndefined();
    expect(deliveryAgent([issue], set)).toBe('issue-9');
    expect(deliveryAgent([issue], empty)).toBe('issue-9');

    expect(armedAgent(verdict(3, 'feat/3'), set)).toBe('issue-3');
    expect(armedAgent(verdict(4, 'feat/4'), set)).toBeUndefined();
    expect(armedAgent(verdict(4, 'feat/4'), empty)).toBe('issue-9');
    expect(armedAgent(verdict(4, 'feat/4'), { armedBy: 'issue-9', armedFor: [] })).toBe('issue-9');

    expect(deliveryAgent([verdict(3, 'feat/3')], set)).toBe('issue-9');
    expect(deliveryAgent([verdict(4, 'feat/4')], set)).toBeUndefined();
    expect(deliveryAgent([issue, verdict(4, 'feat/4')], set)).toBeUndefined();
    expect(deliveryAgent([run], set)).toBeUndefined();
    expect(deliveryAgent([run, verdict(4, 'feat/4')], empty)).toBe('issue-9');
  });

  it('tells a subagent that armed the watch where deliveries go, by the name SendMessage reaches it by', () => {
    const agents = [{ id: 'a1', name: 'issue-113' }, { id: 'a2' }];
    expect(armingAgent(undefined, agents)).toBeUndefined();
    expect(armingAgent('a1', agents)).toBe('issue-113');
    expect(armingAgent('a2', agents)).toBe('a2');
    expect(armingAgent('a3', agents)).toBe('a3');
    const notice = armedNotice('issue-113');
    expect(notice).toContain('armed from agent issue-113');
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
      { forge, ...silent({ config, issuePack: BUILTIN_PACKS['issue']! }), now: () => 1_750_000_000_000, deliver: async (t) => void delivered.push(t) },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, stallMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: { ignoreSelf: true, ignoreBots: true, ci: 'failures', triage: false, protectedBranches: ['main'] } },
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
