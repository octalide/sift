import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/repo/config.ts';
import type { Judge } from '../src/judge/types.ts';
import { GitHubForge, GH_WRITES } from '../src/forge/github.ts';
import { gateOutbound, outboundOf } from '../src/gate/outbound.ts';
import { channelTable, commandBody, defaultChannels, textAbout, type Channel } from '../src/gate/channels.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { entryOf, fillQuestion } from '../src/judge/rank.ts';
import { materialize } from '../src/packs/run.ts';
import { rulesSubject, textRulesSubjects } from '../src/repo/subjects.ts';
import type { Subject } from '../src/packs/types.ts';
import { shellWord } from '../src/shell.ts';
import { memorySource, memoryStore, yesJudge } from './fake-source.ts';

// the channel table reads the forge's write list alone, so the runner is never reached
const github = new GitHubForge(async () => ({ exitCode: 1, stdout: '', stderr: '' }));
// shell channels a config could add for gh, one per write: the text extraction the gate keeps for shell channels
const ghChannels: Channel[] = GH_WRITES.map((w) => {
  const n = w.kind === 'release' ? 'notes' : 'body';
  return { name: `gh-${w.kind}-${w.action}`, tool: '^Bash$', text: { command: String.raw`^\s*gh\s+${w.kind}\s+${w.action}\b`, body: [`--${n}`, `-${n[0]}`], file: [`--${n}-file`, '-F'] }, kind: textAbout(w, github.nouns) };
});
const via = channelTable(defaultChannels(github), ghChannels);
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
    expect(await outboundOf('Bash', { command: 'gh pr comment 5 -b "looks good"' }, noRead, via)).toEqual({ channel: 'gh-pr-comment', text: 'looks good', limit: undefined, kind: 'a comment on a pull request' });
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body "a chore"' }, noRead, via)).toMatchObject({ channel: 'gh-issue-create', kind: 'the title and body of a new GitHub issue' });
    expect(await outboundOf('Bash', { command: 'gh pr view 5 --json body' }, noRead, via)).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh pr create --fill' }, noRead, via)).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh release create v1 --notes "n"' }, noRead, via)).toMatchObject({ channel: 'gh-release-create', text: 'n', kind: 'the title and notes of a new GitHub release' });
    expect(await outboundOf('Bash', { command: 'gh release edit v1 -F notes.md' }, async () => 'notes', via)).toMatchObject({ channel: 'gh-release-edit', text: 'notes' });
    expect(await outboundOf('Bash', { command: 'gh release create v1 --body "n"' }, noRead, via)).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh pr review 5 --approve -b "ship it"' }, noRead, via)).toEqual({ channel: 'gh-pr-review', text: 'ship it', limit: undefined, kind: 'a review on a pull request' });
    expect(await outboundOf('Bash', { command: 'gh pr review 5 --request-changes --body-file r.md' }, async () => 'needs work', via)).toMatchObject({ channel: 'gh-pr-review', text: 'needs work' });
    expect(await outboundOf('Bash', { command: 'gh pr merge 5 --merge --body "Merge #5"' }, noRead, via)).toEqual({ channel: 'gh-pr-merge', text: 'Merge #5', limit: undefined, kind: 'a merge commit message' });
    expect(await outboundOf('Bash', { command: 'gh pr merge 5 --merge -F m.md' }, async () => 'merged', via)).toMatchObject({ channel: 'gh-pr-merge', text: 'merged' });
    expect(await outboundOf('Bash', { command: 'gh pr merge 5 --merge --delete-branch' }, noRead, via)).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh pr review 5 --approve' }, noRead, via)).toBeUndefined();
  });

  it('reads a --body-file - body from the heredoc on stdin', async () => {
    expect(ghBody("gh pr review 5 --approve --body-file - <<'EOF'\n## Review\n\nline two\nEOF")).toEqual({ text: '## Review\n\nline two' });
    expect(ghBody('gh pr merge 5 --merge -F - <<EOF\nmerge #5\nEOF\n')).toEqual({ text: 'merge #5' });
    expect(ghBody('gh issue create -t "t" --body-file=- <<-"END"\n\tindented\n\tEND')).toEqual({ text: '\tindented' });
    expect(ghBody("gh pr review 5 --body-file - <<'EOF'\nnot EOF yet\nEOF\n")).toEqual({ text: 'not EOF yet' });
    expect(ghBody('gh pr review 5 --body-file -')).toEqual({ file: '-' });
    expect(ghBody("gh pr review 5 --body-file - <<'EOF'\nunterminated")).toEqual({ file: '-' });
    expect(await outboundOf('Bash', { command: "gh pr review 5 --approve --body-file - <<'EOF'\nfrom stdin\nEOF" }, noRead, via)).toEqual({ channel: 'gh-pr-review', text: 'from stdin', limit: undefined, kind: 'a review on a pull request' });
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
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file notes.md' }, read, via)).toEqual({ channel: 'gh-issue-create', limit: undefined, kind: 'the title and body of a new GitHub issue', text: 'from the file' });
    expect(reads).toEqual(['notes.md']);
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file -' }, read, via)).toMatchObject({ text: '', denied: expect.stringContaining('stdin') });
    expect(await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file gone.md' }, noRead, via)).toMatchObject({ text: '', denied: 'the body file gone.md cannot be read (ENOENT gone.md)' });
  });

  it('ships discord and one post channel per forge write as the default table', async () => {
    const table = defaultChannels(github);
    expect(table.map((c) => c.name)).toEqual(['discord-message', 'discord-dm', 'discord-forum-post', 'discord-embed', ...GH_WRITES.map((w) => `github-${w.kind}-${w.action}`)]);
    expect(table.find((c) => c.name === 'github-pr-comment')).toEqual({ name: 'github-pr-comment', tool: '^mcp__sift__post$', text: { fields: ['title', 'body'], when: { kind: 'pr-comment' } }, kind: 'a comment on a pull request' });
    expect(defaultChannels().map((c) => c.name)).toEqual(['discord-message', 'discord-dm', 'discord-forum-post', 'discord-embed']);
    // a post is on the channel of its kind alone, and no shell command is on any forge channel
    expect(await outboundOf('mcp__sift__post', { repo: 'o/r', kind: 'issue-create', title: 'T', body: 'B' }, noRead, table)).toEqual({ channel: 'github-issue-create', text: 'T\nB', limit: undefined, kind: 'the title and body of a new GitHub issue' });
    expect(await outboundOf('mcp__sift__post', { repo: 'o/r', kind: 'pr-review', verdict: 'approve', body: 'ok' }, noRead, table)).toMatchObject({ channel: 'github-pr-review', text: 'ok' });
    expect(await outboundOf('mcp__sift__post', { repo: 'o/r', kind: 'pr-merge', method: 'merge' }, noRead, table)).toBeUndefined();
    expect(await outboundOf('Bash', { command: 'gh pr comment 5 -b "x"' }, noRead, table)).toBeUndefined();
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
  const host = () => ({ source: memorySource(docs), judge: yesJudge(), store: memoryStore(), now: () => 1, notice: () => {} });
  const config = { ...DEFAULT_CONFIG, rules: { docs: ['CONTRIBUTING.md'], exclude: [], maxRules: 200 } };

  it('names the artifact in the subject and in every rule question', async () => {
    const body = 'The watcher misses body edits. Steps: edit an issue body, wait a poll.';
    const s = await rulesSubject({ forge: github, ...host() }, { kind: 'text', ref: body, about: 'the body of a new GitHub issue' }, config);
    expect(s.state['subject']).toEqual({ kind: 'text', about: 'the body of a new GitHub issue', text: body });
    expect(s.facts['subject']).toBe('The subject (the body of a new GitHub issue)');
    const step = materialize(BUILTIN_PACKS['rules']!, s).steps[0]!;
    const asked = step.items.map((item, i) => fillQuestion(step.questions['rules']!, entryOf(item, i)).instructions);
    expect(asked[0]).toBe('The subject (the body of a new GitHub issue) complies with this rule: Pull requests: The body carries verification evidence.');
    expect(asked[1]).toContain('Closes #N');
  });

  it('leaves plain text unlabelled', async () => {
    const s = await rulesSubject(host(), { kind: 'text', ref: 'free text' }, config);
    expect(s.state['subject']).toEqual({ kind: 'text', text: 'free text' });
    expect(s.facts['subject']).toBe('The subject');
    expect(materialize(BUILTIN_PACKS['rules']!, s).steps[0]?.questions['rules']?.instructions).toMatch(/^The subject complies with this rule: \{text\}$/);
  });

  it('reads text that fits as one subject, and longer text as its opening and parts', async () => {
    const [one, ...none] = await textRulesSubjects(host(), { text: 'short', about: 'a comment on a pull request' }, config, 100);
    expect(none).toEqual([]);
    expect(one!.state['subject']).toEqual({ kind: 'text', about: 'a comment on a pull request', text: 'short' });
    expect(one!.facts['section']).toBeUndefined();
    const text = `# A\n\n${'a'.repeat(60)}\n\n# B\n\n${'b'.repeat(60)}\n`;
    const parts = await textRulesSubjects(host(), { text }, config, 80);
    expect(parts.map((p) => (p.state['subject'] as { text: string }).text).join('')).toBe(text);
    expect(parts.map((p) => [p.facts['subject'], p.facts['part'], p.facts['section'] ?? false])).toEqual([
      ['The opening, part 1 of 2 ("A"), of the subject', 'the opening, part 1 of 2 ("A")', false],
      ['Part 2 of 2 ("B") of the subject', 'part 2 of 2 ("B")', true],
    ]);
    const [opening, later] = parts.map((p) => materialize(BUILTIN_PACKS['rules']!, p).steps[0]!);
    expect(Object.keys(opening!.questions)).toEqual(['rules']);
    expect(Object.keys(later!.questions)).toEqual(['section']);
  });

  it('describes each artifact and action', () => {
    expect(textAbout({ kind: 'pr', action: 'comment' }, github.nouns)).toBe('a comment on a pull request');
    expect(textAbout({ kind: 'issue', action: 'edit' }, github.nouns)).toBe('the edited title and body of a GitHub issue');
    expect(textAbout({ kind: 'release', action: 'create' }, github.nouns)).toBe('the title and notes of a new GitHub release');
    expect(textAbout({ kind: 'issue', action: 'create' })).toBe('the title and body of a new issue');
    expect(textAbout({ kind: 'pr', action: 'review' }, github.nouns)).toBe('a review on a pull request');
    expect(textAbout({ kind: 'pr', action: 'merge' }, github.nouns)).toBe('a merge commit message');
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
    const d = await gateOutbound({ channel: 'discord', text: 'x'.repeat(2001), limit: 2000 }, [subject], pack, judge([]), DEFAULT_CONFIG);
    expect(d).toMatchObject({ allow: false, reason: 'discord text is 2001 chars, the limit is 2000' });
    expect(d.report).toBeUndefined();
  });

  it('passes an issue body when pull request rules do not apply to it', async () => {
    const docs = { 'CONTRIBUTING.md': '## Pull requests\n\nThe body carries verification evidence.\n\n## Prose\n\nNo em dashes.\n' };
    const config = { ...DEFAULT_CONFIG, rules: { docs: ['CONTRIBUTING.md'], exclude: [], maxRules: 200 } };
    const s = await rulesSubject({ forge: github, source: memorySource(docs), judge: yesJudge(), store: memoryStore(), now: () => 1, notice: () => {} }, { kind: 'text', ref: 'The watcher misses body edits.', about: 'the body of a new GitHub issue' }, config);
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
    const d = await gateOutbound({ channel: 'github-issue-create', text: 'The watcher misses body edits.', kind: 'the body of a new GitHub issue' }, [s], pack, j, config);
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
    expect(await gateOutbound(out!, [fileSubject], pack, j, DEFAULT_CONFIG)).toMatchObject({ allow: false, reason: 'breaks: No em dashes.' });
    expect(seen).toEqual([{ kind: 'text', text: 'a — b' }]);
    const stdin = await outboundOf('Bash', { command: 'gh issue create -t "t" --body-file -' }, async () => '', via);
    const d = await gateOutbound(stdin!, [subject], pack, judge([]), DEFAULT_CONFIG);
    expect(d).toMatchObject({ allow: false, reason: 'the body is read from stdin (--body-file -) with no heredoc in the command, so it cannot be judged; pass --body, a file path or a heredoc' });
    expect(d.report).toBeUndefined();
  });

  it('denies a broken rule, warns on an unclear one, allows the rest', async () => {
    const broken = await gateOutbound({ channel: 'github', text: 'a — b' }, [subject], pack, judge([0.1, 0.9]), DEFAULT_CONFIG);
    expect(broken).toMatchObject({ allow: false, reason: 'breaks: No em dashes.', warnings: [] });
    const unclear = await gateOutbound({ channel: 'github', text: 'ok' }, [subject], pack, judge([0.9, 0.5]), DEFAULT_CONFIG);
    expect(unclear).toMatchObject({ allow: true, reason: 'clear', warnings: ['unclear: Terse by default.'] });
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'off' }) };
    expect((await gateOutbound({ channel: 'github', text: 'ok' }, [subject], pack, off, DEFAULT_CONFIG)).allow).toBe(true);
  });
});
