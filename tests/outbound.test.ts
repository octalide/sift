import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/github/config.ts';
import type { Judge } from '../src/judge/types.ts';
import { gateOutbound, ghBody, outboundOf, shellWord } from '../src/gate/outbound.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { entryOf, fillQuestion } from '../src/judge/rank.ts';
import { materialize } from '../src/packs/run.ts';
import { rulesSubject, textAbout } from '../src/github/subjects.ts';
import type { Subject } from '../src/packs/types.ts';

describe('outbound extraction', () => {
  const noRead = async (p: string) => {
    throw new Error(`ENOENT ${p}`);
  };

  it('reads discord content and embed text', async () => {
    expect(await outboundOf('mcp__discord__send_message', { channel_id: '1', content: 'hello' }, noRead)).toEqual({ channel: 'discord', text: 'hello', maxChars: 2000, kind: undefined, action: undefined });
    expect(await outboundOf('mcp__discord__send_embed', { title: 'T', description: 'D' }, noRead)).toMatchObject({ text: 'D\nT' });
    expect(await outboundOf('mcp__discord__list_channels', {}, noRead)).toBeUndefined();
    expect(await outboundOf('Write', { content: 'x' }, noRead)).toBeUndefined();
  });

  it('reads gh bodies from quoted words and heredocs', async () => {
    expect(shellWord(`'it''s'`)).toBe('it');
    expect(shellWord(`"a \\"quoted\\" word" tail`)).toBe('a "quoted" word');
    expect(shellWord('bare rest')).toBe('bare');
    expect(ghBody(`gh pr create -B dev -t "t" -b "Closes #4\\nbody" --draft`)).toEqual({ text: 'Closes #4\\nbody' });
    expect(ghBody(`gh issue comment 3 --body='single'`)).toEqual({ text: 'single' });
    expect(ghBody(`gh pr create -t "t" -b "$(cat <<'EOF'\n## Summary\n\nline two\nEOF\n)"`)).toEqual({ text: '## Summary\n\nline two' });
    expect(ghBody('gh pr create --fill')).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh pr comment 5 -b "looks good"' }, noRead)).toEqual({ channel: 'github', text: 'looks good', maxChars: undefined, kind: 'pr', action: 'comment' });
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body "a chore"' }, noRead)).toMatchObject({ kind: 'issue', action: 'create' });
    expect(await outboundOf('Bash', { command: 'gh pr view 5 --json body' }, noRead)).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh release create v1 --notes "n"' }, noRead)).toBeUndefined();
  });

  it('reads a --body-file body through the given reader', async () => {
    expect(ghBody('gh issue create -t "t" --body-file notes.md')).toEqual({ file: 'notes.md' });
    expect(ghBody(`gh pr edit 7 -F '/tmp/b.md'`)).toEqual({ file: '/tmp/b.md' });
    expect(ghBody('gh issue comment 3 --body-file=x.md')).toEqual({ file: 'x.md' });
    expect(ghBody('gh issue create -b "inline" --body-file x.md')).toEqual({ text: 'inline' });
    const reads: string[] = [];
    const read = async (p: string) => {
      reads.push(p);
      return 'from the file';
    };
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file notes.md' }, read)).toEqual({ channel: 'github', maxChars: undefined, kind: 'issue', action: 'create', text: 'from the file' });
    expect(reads).toEqual(['notes.md']);
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file -' }, read)).toMatchObject({ text: '', denied: expect.stringContaining('stdin') });
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file gone.md' }, noRead)).toMatchObject({ text: '', denied: 'the body file gone.md cannot be read (ENOENT gone.md)' });
  });
});

describe('rules subject for outbound text', () => {
  const docs = { 'CONTRIBUTING.md': '## Pull requests\n\nThe body carries verification evidence.\n\nClose the issue with Closes #N.\n' };
  const read = async (p: string) => docs[p as keyof typeof docs] ?? '';
  const exists = async (p: string) => p in docs;
  const config = { ...DEFAULT_CONFIG, rules: { docs: ['CONTRIBUTING.md'], maxRules: 200 } };

  it('names the artifact in the subject and in every rule question', async () => {
    const body = 'The watcher misses body edits. Steps: edit an issue body, wait a poll.';
    const s = await rulesSubject(undefined, undefined, { kind: 'text', ref: body, artifact: { kind: 'issue', action: 'create' } }, config, read, exists);
    expect(s.state['subject']).toMatchObject({ kind: 'text', artifact: 'issue', action: 'create', about: 'the body of a new GitHub issue', text: body });
    expect(s.facts['subject']).toBe('The subject (the body of a new GitHub issue)');
    const { expansion } = materialize(BUILTIN_PACKS['rules']!, s);
    const asked = expansion!.items.map((item, i) => fillQuestion(expansion!.questions['rules']!, entryOf(item, i)).instructions);
    expect(asked[0]).toBe('The subject (the body of a new GitHub issue) complies with this rule: Pull requests: The body carries verification evidence.');
    expect(asked[1]).toContain('Closes #N');
  });

  it('leaves plain text unlabelled', async () => {
    const s = await rulesSubject(undefined, undefined, { kind: 'text', ref: 'free text' }, config, read, exists);
    expect(s.state['subject']).toEqual({ kind: 'text', text: 'free text' });
    expect(s.facts['subject']).toBe('The subject');
    expect(materialize(BUILTIN_PACKS['rules']!, s).expansion?.questions['rules']?.instructions).toMatch(/^The subject complies with this rule: \{text\}$/);
  });

  it('describes each artifact and action', () => {
    expect(textAbout({ kind: 'pr', action: 'comment' })).toBe('a comment on a pull request');
    expect(textAbout({ kind: 'issue', action: 'edit' })).toBe('the edited body of a GitHub issue');
    expect(textAbout({ kind: 'release', action: 'create' })).toBe('the notes of a new GitHub release');
  });
});

describe('outbound gate', () => {
  const rules = [{ source: 'CLAUDE.md', text: 'No em dashes.' }, { source: 'CLAUDE.md', text: 'Terse by default.' }];
  const subject: Subject = { kind: 'rules', ref: 'text', state: { subject: { kind: 'text', text: 'x' }, rules }, facts: { rules, has_rules: true, total_rules: 2 }, options: {} };
  const judge = (p: number[]): Judge => ({
    name: 'fake',
    ask: async (_s, q) => ({ ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.keys(q).map((k, i) => [k, { type: 'noul' as const, p: p[i] ?? 0.9 }])) }),
  });
  const pack = BUILTIN_PACKS['rules']!;

  it('denies over the channel limit without asking the judge', async () => {
    const d = await gateOutbound({ channel: 'discord', text: 'x'.repeat(2001), maxChars: 2000 }, subject, pack, judge([]), DEFAULT_CONFIG);
    expect(d).toMatchObject({ allow: false, reason: 'discord text is 2001 chars, the limit is 2000' });
    expect(d.report).toBeUndefined();
  });

  it('passes an issue body when pull request rules do not apply to it', async () => {
    const docs = { 'CONTRIBUTING.md': '## Pull requests\n\nThe body carries verification evidence.\n\n## Prose\n\nNo em dashes.\n' };
    const config = { ...DEFAULT_CONFIG, rules: { docs: ['CONTRIBUTING.md'], maxRules: 200 } };
    const s = await rulesSubject(undefined, undefined, { kind: 'text', ref: 'The watcher misses body edits.', artifact: { kind: 'issue', action: 'create' } }, config, async (p) => docs[p as keyof typeof docs] ?? '', async (p) => p in docs);
    const asked: string[] = [];
    const j: Judge = {
      name: 'fake',
      ask: async (state, q) => {
        asked.push(...Object.values(q).map((x) => x.instructions));
        // a judge that reads the label: a pull request rule does not apply to an issue body, the prose rule is met
        const answers = Object.fromEntries(Object.entries(q).map(([k, x]) => [k, { type: 'noul' as const, p: /Pull requests:/.test(x.instructions) && ((state as Record<string, unknown>)['subject'] as { artifact?: string }).artifact === 'issue' ? 0.5 : 0.9 }]));
        return { ok: true, backend: 'fake', latencyMs: 1, answers };
      },
    };
    const d = await gateOutbound({ channel: 'github', text: 'The watcher misses body edits.', kind: 'issue', action: 'create' }, s, pack, j, config);
    expect(asked[0]).toBe('The subject (the body of a new GitHub issue) complies with this rule: Pull requests: The body carries verification evidence.');
    expect(d).toMatchObject({ allow: true, reason: 'clear', warnings: ['unclear: Pull requests: The body carries verification evidence.'] });
  });

  it('judges a --body-file body and denies one it cannot read', async () => {
    const out = await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file notes.md' }, async () => 'a — b');
    const seen: unknown[] = [];
    const j: Judge = {
      name: 'fake',
      ask: async (state, q) => {
        seen.push((state as { subject: unknown }).subject);
        return { ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.keys(q).map((k, i) => [k, { type: 'noul' as const, p: i === 0 ? 0.1 : 0.9 }])) };
      },
    };
    const fileSubject: Subject = { ...subject, state: { ...subject.state, subject: { kind: 'text', text: out!.text } } };
    expect(await gateOutbound(out!, fileSubject, pack, j, DEFAULT_CONFIG)).toMatchObject({ allow: false, reason: 'breaks: No em dashes.' });
    expect(seen).toEqual([{ kind: 'text', text: 'a — b' }]);
    const stdin = await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file -' }, async () => '');
    const d = await gateOutbound(stdin!, subject, pack, judge([]), DEFAULT_CONFIG);
    expect(d).toMatchObject({ allow: false, reason: 'the body is read from stdin (--body-file -), which cannot be judged; pass --body or a file path' });
    expect(d.report).toBeUndefined();
  });

  it('denies a broken rule, warns on an unclear one, allows the rest', async () => {
    const broken = await gateOutbound({ channel: 'github', text: 'a — b' }, subject, pack, judge([0.1, 0.9]), DEFAULT_CONFIG);
    expect(broken).toMatchObject({ allow: false, reason: 'breaks: No em dashes.', warnings: [] });
    const unclear = await gateOutbound({ channel: 'github', text: 'ok' }, subject, pack, judge([0.9, 0.5]), DEFAULT_CONFIG);
    expect(unclear).toMatchObject({ allow: true, reason: 'clear', warnings: ['unclear: Terse by default.'] });
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'off' }) };
    expect((await gateOutbound({ channel: 'github', text: 'ok' }, subject, pack, off, DEFAULT_CONFIG)).allow).toBe(true);
  });
});
