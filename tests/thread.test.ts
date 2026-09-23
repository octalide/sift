import { describe, expect, it } from 'vitest';
import type { Comment } from '../src/forge/forge.ts';
import { DEFAULT_CONFIG } from '../src/repo/config.ts';
import { issueSubject, prSubject, rulingsOf, threadOf, type ThreadComment } from '../src/repo/subjects.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { formatReport, materialize, runPack } from '../src/packs/run.ts';
import type { Judge } from '../src/judge/types.ts';
import { fakeForge } from './fake-forge.ts';
import { CHATTER, DESIGN, HELD_BEHIND, HOLD, OPEN_QUESTION, OUTSIDER_OVERRIDE, RULING, TWO_DESIGNS } from './fixtures/rulings.ts';

const forgeFor = (issue: typeof OPEN_QUESTION, comments: Comment[]) =>
  fakeForge({ issue: async () => issue, comments: async () => comments, openIssues: async () => [HELD_BEHIND, { number: issue.number, title: issue.title }] });

const ISSUE = { pack: 'issue', kind: 'issue' } as const;

const say = (login: string, association: string, at: string, body: string): Comment => ({ author: { login, bot: false }, association, createdAt: at, body });

describe('issue thread', () => {
  it('carries every comment oldest first with its author, standing and time', async () => {
    const s = await issueSubject(forgeFor(OPEN_QUESTION, [RULING, OUTSIDER_OVERRIDE, HOLD]), 'o/r', 3778, DEFAULT_CONFIG, ISSUE);
    const comments = s.state['comments'] as ThreadComment[];
    expect(comments.map((c) => [c.by, c.association, c.at])).toEqual([
      ['octalide', 'MEMBER', '2026-09-22T20:29:33Z'],
      ['passerby', 'NONE', '2026-09-22T20:40:00Z'],
      ['octalide', 'MEMBER', '2026-09-22T21:45:34Z'],
    ]);
    expect(comments[0]!.text).toBe(RULING.body);
    expect(s.state['recent_comments']).toBeUndefined();
    expect(s.facts['is_new']).toBe(false);
  });

  it('keeps a ruling that six other comments follow', async () => {
    const s = await issueSubject(forgeFor(OPEN_QUESTION, [RULING, ...CHATTER]), 'o/r', 3778, DEFAULT_CONFIG, ISSUE);
    const comments = s.state['comments'] as ThreadComment[];
    expect(comments).toHaveLength(7);
    expect(comments[0]).toMatchObject({ by: 'octalide', association: 'MEMBER', text: RULING.body });
  });

  it('spends the budget on the author and maintainers first, then the newest of the rest', () => {
    const long = (i: number) => 'x'.repeat(100 + i);
    const comments = [
      say('octalide', 'MEMBER', '1', long(1)),
      say('a', 'NONE', '2', long(2)),
      say('b', 'COLLABORATOR', '3', long(3)),
      say('c', 'CONTRIBUTOR', '4', long(4)),
      say('author', 'NONE', '5', long(5)),
      say('d', 'NONE', '6', long(6)),
    ];
    // room for four comments of about a hundred characters: the three that amend, then the newest other
    const kept = threadOf(fakeForge(), 'author', comments, 430);
    expect(kept.map((c) => c.by)).toEqual(['octalide', 'b', 'author', 'd']);
    expect(threadOf(fakeForge(), 'author', comments).map((c) => c.at)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('offers the author and maintainer comments as rulings, never an outsider', async () => {
    const s = await issueSubject(forgeFor(OPEN_QUESTION, [RULING, OUTSIDER_OVERRIDE, HOLD]), 'o/r', 3778, DEFAULT_CONFIG, ISSUE);
    expect(Object.keys(s.options['rulings']!)).toEqual(['octalide at 2026-09-22T20:29:33Z', 'octalide at 2026-09-22T21:45:34Z']);
    expect(s.facts['has_rulings']).toBe(true);
    const outsider = await issueSubject(forgeFor(OPEN_QUESTION, [OUTSIDER_OVERRIDE]), 'o/r', 3778, DEFAULT_CONFIG, ISSUE);
    expect(outsider.options['rulings']).toEqual({});
    expect(outsider.facts['has_rulings']).toBe(false);
    const bare = await issueSubject(forgeFor(TWO_DESIGNS, []), 'o/r', 3747, DEFAULT_CONFIG, ISSUE);
    expect(bare.facts['is_new']).toBe(true);
    expect(rulingsOf(fakeForge(), 'octalide', threadOf(fakeForge(), 'octalide', [DESIGN]))).toEqual({ 'octalide at 2026-09-22T12:00:00Z': expect.stringMatching(/^Design \(steward decision/) });
  });

  it('asks which comment rules and names it in the report', async () => {
    const s = await issueSubject(forgeFor(OPEN_QUESTION, [RULING, OUTSIDER_OVERRIDE]), 'o/r', 3778, DEFAULT_CONFIG, ISSUE);
    const { questions } = materialize(BUILTIN_PACKS['issue']!, s);
    expect(questions['ruling']).toMatchObject({ type: 'choice', criteria: { 'octalide at 2026-09-22T20:29:33Z': expect.any(String), none: expect.any(String) } });
    for (const id of ['substantive', 'implementable', 'scope_clear', 'blocked_by']) expect(questions[id]!.instructions).toMatch(/comment/);
    const judge: Judge = {
      name: 'fake',
      ask: async (_state, qs) => ({
        ok: true,
        backend: 'fake',
        latencyMs: 0,
        answers: Object.fromEntries(
          Object.entries(qs).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', p: 0.9 } : q.type === 'choice' ? { type: 'choice', choice: id === 'ruling' ? 'octalide at 2026-09-22T20:29:33Z' : 'none', probabilities: {}, confidence: 0.9 } : { type: 'score', score: 2, expected: 2, legend: 'ready', probabilities: [0, 0, 1], confidence: 0.9 }]),
        ),
      }),
    };
    const report = await runPack(BUILTIN_PACKS['issue']!, s, judge, DEFAULT_CONFIG);
    expect(formatReport(report)).toContain('ruling = octalide at 2026-09-22T20:29:33Z (0.90)');
    const outsider = await issueSubject(forgeFor(OPEN_QUESTION, [OUTSIDER_OVERRIDE]), 'o/r', 3778, DEFAULT_CONFIG, ISSUE);
    expect(materialize(BUILTIN_PACKS['issue']!, outsider).questions['ruling']).toBeUndefined();
  });

  it('gives a pull request the same thread', async () => {
    const forge = fakeForge({ comments: async () => [say('alice', 'NONE', '2026-01-02T00:00:00Z', 'rebased'), say('rev', 'MEMBER', '2026-01-03T00:00:00Z', 'lgtm')] });
    const s = await prSubject(forge, 'o/r', 7, DEFAULT_CONFIG);
    expect(s.state['comments']).toEqual([
      { by: 'alice', association: 'NONE', at: '2026-01-02T00:00:00Z', text: 'rebased' },
      { by: 'rev', association: 'MEMBER', at: '2026-01-03T00:00:00Z', text: 'lgtm' },
    ]);
    expect(s.state['recent_comments']).toBeUndefined();
  });
});
