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
    log.push(decision({ module: 'compact', ok: false, reason: 'http 413', at: 7 }));
    const stats = await log.stats();
    expect(stats.calls).toBe(6);
    expect(stats.failures).toBe(4);
    expect(stats.session).toMatchObject({ calls: 4, failures: 3 });
    expect(stats.session.lastFailure).toMatchObject({ module: 'compact', at: 7 });
    expect((await log.recent(10)).every((d) => d.session !== undefined)).toBe(true);
    const warnings = log.takeWarnings();
    expect(warnings).toEqual([
      'sift prune fell back 2 times since the last prompt (jev: http 400), the built-in behaviour ran instead',
      'sift compact fell back once since the last prompt (jev: http 413), the built-in behaviour ran instead',
    ]);
    expect(log.takeWarnings()).toEqual([]);
  });
});
