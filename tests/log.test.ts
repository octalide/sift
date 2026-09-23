import { describe, expect, it } from 'vitest';
import type { Decision } from '../src/judge/index.ts';
import { DecisionLog } from '../src/log.ts';

const decision = (over: Partial<Decision>): Decision => ({ at: 1, module: 'prune', backend: 'jev', ok: true, digest: '', action: 'pruned', shadow: false, ...over });

describe('decision log', () => {
  it('splits this session from the shared ring and reports failures once at the next prompt', async () => {
    const store = new Map<string, unknown>([['decisions', [decision({ session: 'old', ok: false, reason: 'http 400' }), decision({ session: 'old' })]]]);
    const log = new DecisionLog({ get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) }, 'now');
    log.push(decision({}));
    log.push(decision({ ok: false, reason: 'rejected: criteria', at: 5 }));
    log.push(decision({ ok: false, reason: 'http 400', at: 6 }));
    log.push(decision({ module: 'message', ok: false, reason: 'http 413', at: 7 }));
    const stats = await log.stats();
    expect(stats.calls).toBe(6);
    expect(stats.failures).toBe(4);
    expect(stats.session).toMatchObject({ calls: 4, failures: 3 });
    expect(stats.session.lastFailure).toMatchObject({ module: 'message', at: 7 });
    expect((await log.recent(10)).every((d) => d.session !== undefined)).toBe(true);
    const warnings = log.takeWarnings();
    expect(warnings).toEqual([
      'sift prune fell back 2 times since the last prompt (jev: http 400), the built-in behaviour ran instead',
      'sift message fell back once since the last prompt (jev: http 413), the built-in behaviour ran instead',
    ]);
    expect(log.takeWarnings()).toEqual([]);
  });

  it('counts every decision of this session once the ring has dropped them', async () => {
    const store = new Map<string, unknown>();
    const log = new DecisionLog({ get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) }, 'now');
    const other = new DecisionLog({ get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) }, 'other');
    for (let i = 0; i < 600; i++) log.push(decision({ at: i, ok: i !== 3, requestTokens: 1 }));
    await log.stats();
    for (let i = 0; i < 400; i++) other.push(decision({ at: i }));
    expect((await other.stats()).session.calls).toBe(400);
    const stats = await log.stats();
    expect(stats.calls).toBe(500);
    expect(stats.session).toMatchObject({ calls: 600, failures: 1, lastFailure: { at: 3 }, cost: { requestTokens: 600 } });
    await log.clear();
    expect((await log.stats()).session).toEqual({ calls: 0, failures: 0, cost: { requestTokens: 0, responseTokens: 0, tokensRemoved: 0 } });
  });
});
