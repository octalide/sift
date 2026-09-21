import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/github/config.ts';
import type { Judge } from '../src/judge/types.ts';
import { GitHubForge, GH_WRITES } from '../src/forge/github.ts';
import { gateOutbound, outboundOf } from '../src/gate/outbound.ts';
import { channelTable, commandBody, defaultChannels, textAbout, type Channel } from '../src/gate/channels.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { entryOf, fillQuestion } from '../src/judge/rank.ts';
import { materialize } from '../src/packs/run.ts';
import { rulesSubject } from '../src/github/subjects.ts';
import type { Subject } from '../src/packs/types.ts';
import { shellWord } from '../src/shell.ts';

// the channel table reads the forge's write list alone, so the runner is never reached
const github = new GitHubForge(async () => ({ exitCode: 1, stdout: '', stderr: '' }));
const via = defaultChannels(github);
const ghBody = (command: string) => commandBody(command, { command: '', body: ['--body', '-b'], file: ['--body-file', '-F'] });

describe('outbound extraction', () => {
  const noRead = async (p: string) => {
    throw new Error(`ENOENT ${p}`);
  };

  it('reads discord content and embed text', async () => {
    expect(await outboundOf('mcp__discord__send_message', { channel_id: '1', content: 'hello' }, noRead)).toEqual({ channel: 'discord-message', text: 'hello', limit: 2000, kind: 'a Discord message' });
    expect(await outboundOf('mcp__discord__send_embed', { title: 'T', description: 'D' }, noRead)).toMatchObject({ channel: 'discord-embed', text: 'D\nT', limit: 2000 });
    expect(await outboundOf('mcp__discord__send_dm', { message: 'hi' }, noRead)).toMatchObject({ channel: 'discord-dm', text: 'hi' });
    expect(await outboundOf('mcp__discord__list_channels', {}, noRead)).toBeUndefined();
    expect(await outboundOf('Write', { content: 'x' }, noRead)).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh pr comment 5 -b "x"' }, noRead)).toBeUndefined();
  });

  it('reads gh bodies from quoted words and heredocs', async () => {
    expect(shellWord(`'it''s'`)).toBe('it');
    expect(shellWord(`"a \\"quoted\\" word" tail`)).toBe('a "quoted" word');
    expect(shellWord('bare rest')).toBe('bare');
    expect(ghBody(`gh pr create -B dev -t "t" -b "Closes #4\\nbody" --draft`)).toEqual({ text: 'Closes #4\\nbody' });
    expect(ghBody(`gh issue comment 3 --body='single'`)).toEqual({ text: 'single' });
    expect(ghBody(`gh pr create -t "t" -b "$(cat <<'EOF'\n## Summary\n\nline two\nEOF\n)"`)).toEqual({ text: '## Summary\n\nline two' });
    expect(ghBody('gh pr create --fill')).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh pr comment 5 -b "looks good"' }, noRead, via)).toEqual({ channel: 'github-pr-comment', text: 'looks good', limit: undefined, kind: 'a comment on a pull request' });
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body "a chore"' }, noRead, via)).toMatchObject({ channel: 'github-issue-create', kind: 'the body of a new GitHub issue' });
    expect(await outboundOf('Bash', { command: 'gh pr view 5 --json body' }, noRead, via)).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh pr create --fill' }, noRead, via)).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh release create v1 --notes "n"' }, noRead, via)).toMatchObject({ channel: 'github-release-create', text: 'n', kind: 'the notes of a new GitHub release' });
    expect(await outboundOf('Bash', { command: 'gh release edit v1 -F notes.md' }, async () => 'notes', via)).toMatchObject({ channel: 'github-release-edit', text: 'notes' });
    expect(await outboundOf('Bash', { command: 'gh release create v1 --body "n"' }, noRead, via)).toBeUndefined();
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
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file notes.md' }, read, via)).toEqual({ channel: 'github-issue-create', limit: undefined, kind: 'the body of a new GitHub issue', text: 'from the file' });
    expect(reads).toEqual(['notes.md']);
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file -' }, read, via)).toMatchObject({ text: '', denied: expect.stringContaining('stdin') });
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file gone.md' }, noRead, via)).toMatchObject({ text: '', denied: 'the body file gone.md cannot be read (ENOENT gone.md)' });
  });

  it('ships the forge writes and discord as the default table', () => {
    expect(via.map((c) => c.name)).toEqual([
      'discord-message',
      'discord-dm',
      'discord-forum-post',
      'discord-embed',
      ...GH_WRITES.map((w) => `github-${w.kind}-${w.action}`),
    ]);
    expect(via.find((c) => c.name === 'github-pr-comment')).toEqual({ name: 'github-pr-comment', tool: '^Bash$', text: { command: String.raw`^\s*gh\s+pr\s+comment\b`, body: ['--body', '-b'], file: ['--body-file', '-F'] }, kind: 'a comment on a pull request' });
    expect(defaultChannels().map((c) => c.name)).toEqual(['discord-message', 'discord-dm', 'discord-forum-post', 'discord-embed']);
  });

  it('takes config channels over the defaults by name, new ones appended', async () => {
    const slack: Channel = { name: 'slack', tool: '^mcp__slack__post_message$', text: { fields: ['text'] }, limit: 40000, kind: 'a Slack message' };
    const shorter: Channel = { name: 'discord-message', tool: '^mcp__discord__send_message$', text: { fields: ['content'] }, limit: 100 };
    const glab: Channel = { name: 'gitlab-mr-note', tool: '^Bash$', text: { command: String.raw`^glab\s+mr\s+note\b`, body: ['--message', '-m'] }, kind: 'a note on a merge request' };
    const table = channelTable(via, [slack, shorter, glab]);
    expect(table.map((c) => c.name)).toEqual([...via.map((c) => c.name), 'slack', 'gitlab-mr-note']);
    expect(table[0]).toBe(shorter);
    expect(await outboundOf('mcp__slack__post_message', { text: 'hey' }, noRead, table)).toEqual({ channel: 'slack', text: 'hey', limit: 40000, kind: 'a Slack message' });
    expect(await outboundOf('mcp__discord__send_message', { content: 'hi' }, noRead, table)).toEqual({ channel: 'discord-message', text: 'hi', limit: 100, kind: undefined });
    expect(await outboundOf('mcp__discord__edit_message', { content: 'hi' }, noRead, table)).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'glab mr note 4 -m "fine"' }, noRead, table)).toMatchObject({ channel: 'gitlab-mr-note', text: 'fine' });
    expect(await outboundOf('Bash', { command: 'glab mr note 4 -F x.md' }, noRead, table)).toBeUndefined();
  });
});

describe('rules subject for outbound text', () => {
  const docs = { 'CONTRIBUTING.md': '## Pull requests\n\nThe body carries verification evidence.\n\nClose the issue with Closes #N.\n' };
  const read = async (p: string) => docs[p as keyof typeof docs] ?? '';
  const exists = async (p: string) => p in docs;
  const config = { ...DEFAULT_CONFIG, rules: { docs: ['CONTRIBUTING.md'], maxRules: 200 } };

  it('names the artifact in the subject and in every rule question', async () => {
    const body = 'The watcher misses body edits. Steps: edit an issue body, wait a poll.';
    const s = await rulesSubject({ forge: github, read, exists }, { kind: 'text', ref: body, about: 'the body of a new GitHub issue' }, config);
    expect(s.state['subject']).toEqual({ kind: 'text', about: 'the body of a new GitHub issue', text: body });
    expect(s.facts['subject']).toBe('The subject (the body of a new GitHub issue)');
    const step = materialize(BUILTIN_PACKS['rules']!, s).steps[0]!;
    const asked = step.items.map((item, i) => fillQuestion(step.questions['rules']!, entryOf(item, i)).instructions);
    expect(asked[0]).toBe('The subject (the body of a new GitHub issue) complies with this rule: Pull requests: The body carries verification evidence.');
    expect(asked[1]).toContain('Closes #N');
  });

  it('leaves plain text unlabelled', async () => {
    const s = await rulesSubject({ read, exists }, { kind: 'text', ref: 'free text' }, config);
    expect(s.state['subject']).toEqual({ kind: 'text', text: 'free text' });
    expect(s.facts['subject']).toBe('The subject');
    expect(materialize(BUILTIN_PACKS['rules']!, s).steps[0]?.questions['rules']?.instructions).toMatch(/^The subject complies with this rule: \{text\}$/);
  });

  it('describes each artifact and action', () => {
    expect(textAbout({ kind: 'pr', action: 'comment' }, github.nouns)).toBe('a comment on a pull request');
    expect(textAbout({ kind: 'issue', action: 'edit' }, github.nouns)).toBe('the edited body of a GitHub issue');
    expect(textAbout({ kind: 'release', action: 'create' }, github.nouns)).toBe('the notes of a new GitHub release');
    expect(textAbout({ kind: 'issue', action: 'create' })).toBe('the body of a new issue');
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
    const d = await gateOutbound({ channel: 'discord', text: 'x'.repeat(2001), limit: 2000 }, subject, pack, judge([]), DEFAULT_CONFIG);
    expect(d).toMatchObject({ allow: false, reason: 'discord text is 2001 chars, the limit is 2000' });
    expect(d.report).toBeUndefined();
  });

  it('passes an issue body when pull request rules do not apply to it', async () => {
    const docs = { 'CONTRIBUTING.md': '## Pull requests\n\nThe body carries verification evidence.\n\n## Prose\n\nNo em dashes.\n' };
    const config = { ...DEFAULT_CONFIG, rules: { docs: ['CONTRIBUTING.md'], maxRules: 200 } };
    const s = await rulesSubject({ forge: github, read: async (p) => docs[p as keyof typeof docs] ?? '', exists: async (p) => p in docs }, { kind: 'text', ref: 'The watcher misses body edits.', about: 'the body of a new GitHub issue' }, config);
    const asked: string[] = [];
    const j: Judge = {
      name: 'fake',
      ask: async (state, q) => {
        asked.push(...Object.values(q).map((x) => x.instructions));
        // a judge that reads the label: a pull request rule does not apply to an issue body, the prose rule is met
        const answers = Object.fromEntries(Object.entries(q).map(([k, x]) => [k, { type: 'noul' as const, p: /Pull requests:/.test(x.instructions) && /issue/.test(((state as Record<string, unknown>)['subject'] as { about?: string }).about ?? '') ? 0.5 : 0.9 }]));
        return { ok: true, backend: 'fake', latencyMs: 1, answers };
      },
    };
    const d = await gateOutbound({ channel: 'github-issue-create', text: 'The watcher misses body edits.', kind: 'the body of a new GitHub issue' }, s, pack, j, config);
    expect(asked[0]).toBe('The subject (the body of a new GitHub issue) complies with this rule: Pull requests: The body carries verification evidence.');
    expect(d).toMatchObject({ allow: true, reason: 'clear', warnings: ['unclear: Pull requests: The body carries verification evidence.'] });
  });

  it('judges a --body-file body and denies one it cannot read', async () => {
    const out = await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file notes.md' }, async () => 'a — b', via);
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
    const stdin = await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file -' }, async () => '', via);
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
