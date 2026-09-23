import { describe, expect, it } from 'vitest';
import type { Comment } from '../src/forge/forge.ts';
import { CONTEXT_ROOM, cutMessage, fitTexts, STATE_ROOM, textTokens } from '../src/judge/room.ts';
import { DEFAULT_CONFIG } from '../src/repo/config.ts';
import { commitSubject, planSubject, prSubject, textSubject } from '../src/repo/subjects.ts';
import { eventSubject } from '../src/watch/triage.ts';
import { treeSubject } from '../src/locate/tree.ts';
import { estimateTokensOf } from '../src/tokens.ts';
import { fakeForge } from './fake-forge.ts';

// plain prose of at least n characters, about four characters to a token
const prose = (n: number, word = 'change'): string => {
  let text = '';
  for (let i = 0; text.length < n; i++) text += `Paragraph ${i} says one ${word} in plain words, at some length.\n\n`;
  return text;
};
// dense json-like text, about one token to a character, so a short text passes the room
const dense = (n: number): string => '{"k":[1,2]}'.repeat(Math.ceil(n / 11));

const say = (login: string, association: string, at: string, body: string): Comment => ({ author: { login, bot: false }, association, createdAt: at, body });

describe('room', () => {
  it('keeps every text whole when the state fits', () => {
    const fit = fitTexts([{ name: 'a', text: 'one' }, { name: 'b', text: 'two', tier: 1 }], ([a, b]) => ({ a, b }), 100);
    expect(fit).toEqual({ state: { a: 'one', b: 'two' }, texts: ['one', 'two'], cuts: [] });
  });

  it('shares a tier evenly, a text under its share whole, and names every cut', () => {
    const small = 'short';
    const big = dense(10_000);
    const fit = fitTexts([{ name: 'small', text: small }, { name: 'big', text: big }, { name: 'big too', text: big }], ([a, b, c]) => ({ a, b, c }), 2_000);
    expect(estimateTokensOf(fit.state)).toBeLessThanOrEqual(2_000);
    expect(fit.texts[0]).toBe(small);
    expect(fit.texts[1]).toMatch(/…$/);
    expect(Math.abs(fit.texts[1]!.length - fit.texts[2]!.length)).toBeLessThanOrEqual(12);
    expect(fit.cuts.map((c) => c.name)).toEqual(['big', 'big too']);
    expect(fit.cuts[0]).toEqual({ name: 'big', judged: fit.texts[1]!.length - 1, length: big.length });
    expect(cutMessage(fit.cuts)).toBe(`the judge read part of this subject, the rest is more than its state holds: big (the first ${fit.cuts[0]!.judged} of ${big.length} characters), big too (the first ${fit.cuts[1]!.judged} of ${big.length} characters)`);
  });

  it('gives a lower tier its room first, a later tier what is left, and names a text left no room', () => {
    const big = dense(10_000);
    const fit = fitTexts([{ name: 'first', text: big, tier: 0 }, { name: 'then', text: big, tier: 1 }], ([a, b]) => ({ a, b }), 2_000);
    expect(fit.texts[1]).toBe('');
    expect(fit.cuts.at(-1)).toEqual({ name: 'then', judged: 0, length: big.length });
    expect(cutMessage([fit.cuts.at(-1)!])).toMatch(/then \(not read\)$/);
  });

  it('reads a pull request body and its linked issue whole past 20,000 characters', async () => {
    const body = `Closes #3\n\n${prose(40_000)}`;
    const issueBody = prose(40_000, 'thing');
    const forge = fakeForge({
      pull: async (r, n) => ({ ...(await fakeForge().pull(r, n)), body }),
      issue: async (r, n) => ({ ...(await fakeForge().issue(r, n)), body: issueBody }),
      closingIssues: async () => [3],
      comments: async () => [say('bob', 'NONE', '2026-01-02T00:00:00Z', prose(80_000, 'aside'))],
    });
    const s = await prSubject(forge, 'o/r', 7, DEFAULT_CONFIG);
    expect(s.state['body']).toBe(body);
    expect((s.state['linked_issue'] as { body: string }).body).toBe(issueBody);
    expect(estimateTokensOf(s.state)).toBeLessThanOrEqual(STATE_ROOM);
    expect(s.cuts).toEqual([{ name: 'the comment by bob at 2026-01-02T00:00:00Z', judged: expect.any(Number), length: expect.any(Number) }]);
  });

  it('reads an issue body and a plan whole past 20,000 characters, and cuts them evenly when they do not fit', async () => {
    const forgeWith = (body: string) => fakeForge({ issue: async (r, n) => ({ ...(await fakeForge().issue(r, n)), body }) });
    const body = prose(40_000);
    const plan = prose(40_000, 'step');
    const s = await planSubject(forgeWith(body), 'o/r', 3, plan, 'plan');
    expect(s.state['plan']).toBe(plan);
    expect((s.state['issue'] as { body: string }).body).toBe(body);
    expect(s.cuts).toBeUndefined();
    const cut = await planSubject(forgeWith(dense(60_000)), 'o/r', 3, dense(60_000), 'plan');
    expect(estimateTokensOf(cut.state)).toBeLessThanOrEqual(STATE_ROOM);
    expect(cut.cuts!.map((c) => c.name)).toEqual(['the issue body', 'the plan']);
    expect(Math.abs(cut.cuts![0]!.judged - cut.cuts![1]!.judged)).toBeLessThanOrEqual(12);
  });

  it('reads commit bodies, free text, an event and the locate text by the room, not a character count', async () => {
    const long = prose(10_000);
    const git = async () => `\x1e${'a'.repeat(40)}\nfix(#1): one\n\n${long}`;
    const c = await commitSubject(git as never, 'HEAD', DEFAULT_CONFIG);
    expect((c.state['commits'] as { body: string }[])[0]!.body.trim()).toBe(long.trim());
    const t = textSubject(prose(40_000), prose(40_000, 'context'));
    expect(t.state['text']).toBe(prose(40_000));
    expect(t.state['context']).toBe(prose(40_000, 'context'));
    const e = eventSubject('o/r', { id: 'e', kind: 'issue', number: 1, title: 't', changes: [], user: 'a', bot: false, url: 'u', at: 1, isNew: true }, { body: prose(20_000), latestComment: { by: 'b', text: prose(10_000) } });
    expect(e.state['body']).toBe(prose(20_000));
    expect((e.state['latest_comment'] as { text: string }).text).toBe(prose(10_000));
    const tree = treeSubject(prose(40_000), 'x', { dirs: [], files: [], skipped: 0 });
    expect(tree.state['text']).toBe(prose(40_000));
    const over = treeSubject(dense(40_000), 'x', { dirs: [], files: [], skipped: 0 });
    expect(estimateTokensOf(over.state)).toBeLessThanOrEqual(CONTEXT_ROOM);
    expect(over.cuts).toEqual([{ name: 'the text', judged: expect.any(Number), length: dense(40_000).length }]);
    expect(textTokens(over.state['text'] as string)).toBeGreaterThan(CONTEXT_ROOM - 100);
  });
});
