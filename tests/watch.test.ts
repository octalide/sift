import { describe, expect, it } from 'vitest';
import { Gh } from '../src/github/gh.ts';
import { DEFAULT_CONFIG } from '../src/github/config.ts';
import type { Judge, Questions } from '../src/judge/types.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { diffItems, diffRuns, hashOf, settleChecks, toItem, type Item, type WatchEvent } from '../src/watch/poll.ts';
import { routeByRules, type WatchRules } from '../src/watch/triage.ts';
import { Watcher, summarize } from '../src/watch/watcher.ts';

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
    const run = { name: 'ci', branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', sha: 'abc', url: 'u', actor: 'a', updated: '1' };
    expect(diffRuns({}, { '1': { ...run, status: 'in_progress' } }, 0)).toHaveLength(0);
    expect(diffRuns({ '1': { ...run, status: 'in_progress' } }, { '1': run }, 0)).toHaveLength(1);
    expect(diffRuns({ '1': run }, { '1': run }, 0)).toHaveLength(0);
  });

  it('settles a head only once every check and status has finished', () => {
    const done = { name: 'build', status: 'completed', conclusion: 'success' };
    expect(settleChecks([done, { name: 'test', status: 'in_progress', conclusion: null }], [])).toBeUndefined();
    expect(settleChecks([done], [{ context: 'ext', state: 'pending' }])).toBeUndefined();
    expect(settleChecks([done, { name: 'test', status: 'completed', conclusion: 'success' }], [{ context: 'ext', state: 'success' }])).toEqual({ conclusion: 'success', total: 3, failed: [] });
    expect(settleChecks([done, { name: 'test', status: 'completed', conclusion: 'failure' }], [])).toEqual({ conclusion: 'failure', total: 2, failed: ['test'] });
    expect(settleChecks([], [])).toEqual({ conclusion: 'success', total: 0, failed: [] });
  });

  it('keeps no bodies in the store', () => {
    const i = toItem({ n: 1, t: 't', s: 'open', u: 'x[bot]', bl: 9, bp: 'long body', c: 0, l: '', up: '1', cr: '2026-02-01', url: 'u', pr: false, m: false });
    expect(i.bot).toBe(true);
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
    expect(routeByRules(event({ kind: 'ci', conclusion: 'success', branch: 'feat/12', settled: true }), rules).action).toBe('deliver');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'success', branch: 'feat/12', settled: true }), { ...rules, ci: 'none' }).action).toBe('drop');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'failure', branch: 'main' }), rules).action).toBe('deliver');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'failure', branch: 'feat/12' }), rules).action).toBe('deliver');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'failure', branch: 'scratch' }), rules).action).toBe('defer');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'success', branch: 'main' }), rules).action).toBe('defer');
    expect(routeByRules(event({ kind: 'ci', conclusion: 'success' }), { ...rules, ci: 'all' }).action).toBe('deliver');
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

// a gh that answers from canned responses, one per call in order
function fakeGh(responses: (() => string)[]): Gh {
  let i = 0;
  return new Gh(async (argv) => {
    if (argv[0] === 'gh' && argv[1] === 'api') {
      const next = responses[i++] ?? (() => 'HTTP/2.0 304 Not Modified\r\n\r\n');
      const out = next();
      // a --jq page request gets the body alone, already in the slim shape
      if (argv[2] === '--jq') return { exitCode: 0, stdout: out.slice(out.indexOf('\r\n\r\n') + 4), stderr: '' };
      return { exitCode: 0, stdout: out, stderr: '' };
    }
    return { exitCode: 0, stdout: '{}', stderr: '' };
  });
}

const page = (body: unknown, etag = '"e"') => () => `HTTP/2.0 200 OK\r\nEtag: ${etag}\r\nX-Ratelimit-Remaining: 4000\r\n\r\n${JSON.stringify(body)}`;
const notModified = () => 'HTTP/2.0 304 Not Modified\r\n\r\n';
const issue = (n: number, over: Record<string, unknown> = {}) => ({ number: n, title: `Issue ${n}`, state: 'open', user: { login: 'alice' }, body: 'b', comments: 0, labels: [], updated_at: `2026-01-0${n}T00:00:00Z`, html_url: `https://x/${n}`, ...over });
const slim = (n: number, over: Record<string, unknown> = {}) => ({ n, t: `Issue ${n}`, s: 'open', u: 'alice', bl: 1, bp: 'b', c: 0, l: '', up: `2026-01-0${n}T00:00:00Z`, cr: `2026-01-0${n}T00:00:00Z`, url: `https://x/${n}`, pr: false, m: false, ...over });

describe('watcher', () => {
  it('seeds silently, then delivers judged events and defers the rest with a digest', async () => {
    const gh = fakeGh([
      // tick 1: seed
      page([issue(1)]),
      page([slim(1), slim(2)]),
      page({ workflow_runs: [] }),
      // tick 2: issue 2 got a comment (judged), issue 1 got a label (deferred)
      page([issue(2)], '"f"'),
      page([slim(1, { l: 'p1' }), slim(2, { c: 1, up: '2026-01-03T00:00:00Z' })]),
      notModified,
      // detail fetches for the judged event
      page(issue(2, { comments: 1 })),
      page([{ user: { login: 'bob' }, body: 'is this still planned?' }]),
    ]);
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
        gh,
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
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: { ignoreSelf: false, ignoreBots: true, ci: 'failures', triage: true, protectedBranches: ['main'] } },
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

  it('delivers one settled verdict per pr head when the last check completes', async () => {
    const run = (id: number, name: string, status: string, conclusion: string | null) => ({ id, name, head_branch: 'feat/3', event: 'push', status, conclusion, head_sha: 'abc1234def', html_url: `https://x/runs/${id}`, actor: { login: 'me' }, updated_at: '1' });
    const pulls = page([{ number: 3, title: 'Feat 3', head: { ref: 'feat/3', sha: 'abc1234def' }, html_url: 'https://x/pull/3' }]);
    const gh = fakeGh([
      // the login lookup for ignoreSelf
      page({ login: 'me' }),
      // tick 1: seed with both workflows running
      page([issue(1)]),
      page([slim(1)]),
      page({ workflow_runs: [run(10, 'build', 'in_progress', null), run(11, 'test', 'in_progress', null)] }),
      // tick 2: build finished, test still running
      notModified,
      page({ workflow_runs: [run(10, 'build', 'completed', 'success'), run(11, 'test', 'in_progress', null)] }, '"r2"'),
      pulls,
      page({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'in_progress', conclusion: null }] }),
      page({ statuses: [] }),
      // tick 3: test finished too
      notModified,
      page({ workflow_runs: [run(10, 'build', 'completed', 'success'), run(11, 'test', 'completed', 'success')] }, '"r3"'),
      pulls,
      page({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'success' }] }),
      page({ statuses: [] }),
    ]);
    const delivered: string[] = [];
    const decisions: string[] = [];
    const watcher = new Watcher(
      {
        gh,
        store: { get: async () => undefined, set: async () => {} },
        judge: { name: 'fake', ask: async () => ({ ok: false, backend: 'fake', latencyMs: 0, error: 'off' }) },
        pack: BUILTIN_PACKS['triage']!,
        config: DEFAULT_CONFIG,
        now: () => 1_000_000,
        deliver: async (t) => void delivered.push(t),
        log: () => {},
        status: () => {},
        schedule: () => ({ cancel: () => {} }),
        onDecision: (e, action, label) => decisions.push(`${action} ${e.id} ${label}`),
      },
      { repo: 'o/r', minIntervalMs: 1, maxIntervalMs: 2, deferMaxAgeMs: 1e9, seedWindowMs: 1e12, rateFloor: 10, shadow: false, rules: { ignoreSelf: true, ignoreBots: true, ci: 'failures', triage: false, protectedBranches: ['main'], branchPattern: '^feat/\\d+$' } },
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
  });
});
