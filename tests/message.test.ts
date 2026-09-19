import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/github/config.ts';
import type { Gh } from '../src/github/gh.ts';
import type { Judge, Questions } from '../src/judge/types.ts';
import { heldDigest, judgeMessage, messageRefs, messageSubject, refDetail } from '../src/message/message.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';

describe('message refs', () => {
  it('finds urls, owner/name#n and bare #n against the session repo, deduped and capped', () => {
    const text = 'DONE x-1: merged https://github.com/o/r/pull/18 and o/r#18, closes #14, see briar-systems/mach#7 and #9 and #10';
    expect(messageRefs(text, 'o/r')).toEqual([
      { repo: 'o/r', number: 18 },
      { repo: 'briar-systems/mach', number: 7 },
      { repo: 'o/r', number: 14 },
    ]);
    expect(messageRefs('nothing here #5')).toEqual([]);
  });
});

describe('message subject', () => {
  it('fetches a pr with its checks and diff, and an issue without, and survives a missing item', async () => {
    const gh = {
      json: async (path: string) => {
        if (path === 'repos/o/r/issues/18') return { title: 'PR', state: 'open', body: 'b', pull_request: {} };
        if (path === 'repos/o/r/pulls/18') return { merged: false, head: { sha: 'abc' } };
        if (path.includes('check-runs')) return { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }] };
        if (path === 'repos/o/r/issues/14') return { title: 'Issue', state: 'closed', body: 'ib' };
        throw new Error(`http 404 ${path}`);
      },
      text: async () => 'diff --git a b',
    } as unknown as Gh;
    const [pr, issue, missing] = await Promise.all([refDetail(gh, { repo: 'o/r', number: 18 }), refDetail(gh, { repo: 'o/r', number: 14 }), refDetail(gh, { repo: 'o/r', number: 99 })]);
    expect(pr).toMatchObject({ kind: 'pr', checks: { failed: ['test'], pending: ['lint'], total: 2 }, diff: 'diff --git a b' });
    expect(issue).toMatchObject({ kind: 'issue', state: 'closed', body: 'ib' });
    expect(issue.diff).toBeUndefined();
    expect(missing.error).toMatch(/404/);
    const subject = messageSubject('DONE: merged o/r#18', 'peer', [pr, missing]);
    expect(subject.facts['has_refs']).toBe(true);
    expect((subject.state as { refs: { url: string }[] }).refs[0]!.url).toBe('https://github.com/o/r/pull/18');
    expect(messageSubject('hi', 'peer', [missing]).facts['has_refs']).toBe(false);
  });
});

describe('message triage', () => {
  const judge = (actionable: number, withRefs: boolean): Judge => ({
    name: 'fake',
    ask: async (_s, q: Questions) => {
      expect('measured' in q).toBe(withRefs);
      return {
        ok: true,
        backend: 'fake',
        latencyMs: 1,
        answers: {
          actionable: { type: 'noul', p: actionable },
          kind: { type: 'choice', choice: 'status', probabilities: {}, confidence: 0.8 },
          urgency: { type: 'score', score: 0, expected: 0, legend: 'later: x', probabilities: [1, 0, 0], confidence: 0.7 },
          ...(withRefs ? { measured: { type: 'noul' as const, p: 0.4 }, evidenced: { type: 'noul' as const, p: 0.2 } } : {}),
        },
      };
    },
  });
  const pack = BUILTIN_PACKS['message']!;

  it('consumes the violated band and delivers the rest with scores on one line', async () => {
    const plain = messageSubject('ack', 'peer', []);
    expect(await judgeMessage(pack, plain, judge(0.1, false), DEFAULT_CONFIG)).toEqual({ action: 'consume', label: 'actionable 0.10, kind status, urgency later' });
    expect((await judgeMessage(pack, plain, judge(0.5, false), DEFAULT_CONFIG)).action).toBe('deliver');
    const withRef = messageSubject('DONE o/r#18', 'peer', [{ repo: 'o/r', number: 18, kind: 'pr', title: 't', state: 'open', merged: false, body: '' }]);
    const t = await judgeMessage(pack, withRef, judge(0.9, true), DEFAULT_CONFIG);
    expect(t).toEqual({ action: 'deliver', label: 'actionable 0.90, kind status, urgency later, measured 0.40, evidenced 0.20' });
  });

  it('delivers when the judge is unavailable', async () => {
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'off' }) };
    const t = await judgeMessage(pack, messageSubject('x', 'peer', []), off, DEFAULT_CONFIG);
    expect(t.action).toBe('deliver');
    expect(t.error).toBeDefined();
  });

  it('digests held messages into one line', () => {
    expect(heldDigest([])).toBe('');
    expect(heldDigest([{ at: 0, from: 'mach', head: 'ANSWER m-1: standby (nothing new)', label: 'actionable 0.08, kind noise, urgency later' }])).toBe(
      'held meanwhile (1): mach: ANSWER m-1: standby (nothing new) [actionable 0.08, kind noise, urgency later]',
    );
  });
});
