import { describe, expect, it } from 'vitest';
import type { ForgePost } from '../src/forge/forge.ts';
import { GitHubForge, GH_WRITES } from '../src/forge/github.ts';
import type { Judge } from '../src/judge/types.ts';
import { postCall, postOf, rawWriteOf, rawWriteRefusal } from '../src/gate/post.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { DEFAULT_CONFIG, resolveConfig, type RepoConfig } from '../src/repo/config.ts';
import { simpleCommands } from '../src/shell.ts';
import { fakeForge } from './fake-forge.ts';
import { memoryStore } from './fake-source.ts';

const github = new GitHubForge(async () => ({ exitCode: 1, stdout: '', stderr: '' }));

describe('shell commands', () => {
  it('splits a command line into its simple commands, words unquoted', () => {
    expect(simpleCommands(`cd /x && gh pr create -t "a title" -b 'b'`)).toEqual([['cd', '/x'], ['gh', 'pr', 'create', '-t', 'a title', '-b', 'b']]);
    expect(simpleCommands('a; b | c || d & e\nf')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f']]);
    expect(simpleCommands('GH_REPO=o/r env gh pr merge 5 --merge # sift: full')).toEqual([['gh', 'pr', 'merge', '5', '--merge']]);
    expect(simpleCommands('(cd a; gh release create v1 --notes n) &>log 2>&1')).toEqual([['cd', 'a'], ['gh', 'release', 'create', 'v1', '--notes', 'n']]);
    expect(simpleCommands('echo hi>f 2>/dev/null <in')).toEqual([['echo', 'hi']]);
  });

  it('reads commands inside $( ), backticks and double quotes', () => {
    expect(simpleCommands('x="$(gh issue comment 3 -b "hi there")"; echo "$x"')).toEqual([['gh', 'issue', 'comment', '3', '-b', 'hi there'], ['echo', '$x']]);
    expect(simpleCommands('echo `gh api repos/o/r/issues -f title=x` done')).toEqual([['gh', 'api', 'repos/o/r/issues', '-f', 'title=x'], ['echo', 'done']]);
  });

  it('drops heredoc bodies and quoted text that only mentions a command', () => {
    expect(simpleCommands(`url=$(gh pr create --title 'a' --body-file - <<'EOF'\nhello; gh issue create\nEOF\n)`)).toEqual([['gh', 'pr', 'create', '--title', 'a', '--body-file', '-']]);
    expect(simpleCommands('cat <<-EOF > f.md\n\tgh pr comment 1 -b x\n\tEOF\ngh pr view 1 | head')).toEqual([['cat'], ['gh', 'pr', 'view', '1'], ['head']]);
    expect(simpleCommands('echo "use gh pr create; then wait" > /dev/null')).toEqual([['echo', 'use gh pr create; then wait']]);
  });
});

describe('shell writes', () => {
  it('finds a forge write anywhere in a command line and passes reads', () => {
    expect(rawWriteOf(github, `cd ../sift-167 && gh pr create --base dev --title t --body-file - <<'EOF'\nbody\nEOF`)).toEqual({ kind: 'pr', action: 'create' });
    expect(rawWriteOf(github, 'n=$(gh api repos/o/r/issues/3/comments -f body=hi --jq .id)')).toEqual({ kind: 'issue', action: 'comment' });
    expect(rawWriteOf(github, 'gh pr view 3 --json body && gh pr checks 3')).toBeUndefined();
    expect(rawWriteOf(github, `cat > notes.md <<'EOF'\nrun gh issue create -t x\nEOF`)).toBeUndefined();
    expect(rawWriteOf(github, 'gh pr merge 3 --merge --delete-branch')).toBeUndefined();
  });

  it('names the post call that replaces the refused write', () => {
    const text = rawWriteRefusal(github, { kind: 'pr', action: 'comment' });
    expect(text).toContain('a comment on a pull request');
    expect(text).toContain('mcp__sift__post');
    expect(text).toContain('kind: "pr-comment"');
    expect(text).toContain('number');
    expect(rawWriteRefusal(github, { kind: 'release', action: 'create' })).toContain('tag');
  });
});

describe('post input', () => {
  it('reads each write from the tool input', () => {
    expect(postOf({ repo: 'o/r', kind: 'issue-create', title: 't', body: 'b' }, github)).toEqual({ repo: 'o/r', post: { kind: 'issue', action: 'create', title: 't', body: 'b' } });
    expect(postOf({ repo: 'o/r', kind: 'pr-create', title: 't', body: 'b', base: 'dev', head: 'feat/1', draft: true }, github)).toMatchObject({ post: { kind: 'pr', action: 'create', base: 'dev', head: 'feat/1', draft: true } });
    expect(postOf({ repo: 'o/r', kind: 'pr-comment', number: '#4', body: 'c' }, github)).toEqual({ repo: 'o/r', post: { kind: 'pr', action: 'comment', number: 4, body: 'c' } });
    expect(postOf({ repo: 'o/r', kind: 'issue-edit', number: 4, title: 'new' }, github)).toMatchObject({ post: { kind: 'issue', action: 'edit', number: 4, title: 'new' } });
    expect(postOf({ repo: 'o/r', kind: 'pr-review', number: 4, verdict: 'approve' }, github)).toMatchObject({ post: { kind: 'pr', action: 'review', verdict: 'approve' } });
    expect(postOf({ repo: 'o/r', kind: 'pr-merge', number: 4, method: 'merge' }, github)).toMatchObject({ post: { kind: 'pr', action: 'merge', method: 'merge' } });
    expect(postOf({ repo: 'o/r', kind: 'release-create', tag: 'v1', body: 'n', prerelease: true }, github)).toMatchObject({ post: { kind: 'release', action: 'create', tag: 'v1', prerelease: true } });
    expect(postOf({ repo: 'o/r', kind: 'release-edit', tag: 'v1', body: 'n' }, github)).toMatchObject({ post: { kind: 'release', action: 'edit', tag: 'v1' } });
  });

  it('refuses a missing or malformed field by name', () => {
    const error = (input: Record<string, unknown>) => (postOf(input, github) as { error: string }).error;
    expect(error({ kind: 'issue-create', title: 't', body: 'b' })).toMatch(/^repo is the repository/);
    expect(error({ repo: 'o/r', kind: 'issue-close' })).toBe(`kind is one of ${GH_WRITES.map((w) => `${w.kind}-${w.action}`).join(', ')}, got "issue-close"`);
    expect(error({ repo: 'o/r', kind: 'issue-create', body: 'b' })).toBe('issue-create needs title and body');
    expect(error({ repo: 'o/r', kind: 'pr-create', title: 't', body: 'b' })).toBe('pr-create needs base and head');
    expect(error({ repo: 'o/r', kind: 'pr-comment', body: 'c' })).toMatch(/^pr-comment needs number/);
    expect(error({ repo: 'o/r', kind: 'issue-edit', number: 3 })).toBe('issue-edit needs title or body');
    expect(error({ repo: 'o/r', kind: 'pr-review', number: 3, verdict: 'lgtm' })).toBe('pr-review needs verdict, one of approve, request-changes, comment');
    expect(error({ repo: 'o/r', kind: 'pr-merge', number: 3 })).toBe('pr-merge needs method, one of merge, squash, rebase');
    expect(error({ repo: 'o/r', kind: 'release-create', body: 'n' })).toBe('release-create needs tag');
  });
});

describe('post', () => {
  const docs: Record<string, Record<string, string>> = {
    'o/target': { 'CONTRIBUTING.md': '## Prose\n\nNo em dashes in anything you write.\n' },
    'o/caller': { 'CONTRIBUTING.md': '## Prose\n\nEvery comment ends with a haiku.\n' },
  };
  // a judge that keeps every document and paragraph, and breaks the em dash rule on text with one
  const judge = (asked: string[] = []): Judge => ({
    name: 'fake',
    ask: async (state, q) => {
      const text = String(((state as Record<string, unknown>)['subject'] as { text?: string } | undefined)?.text ?? '');
      const answers = Object.fromEntries(
        Object.entries(q).map(([k, x]) => {
          if (/complies with this rule/.test(x.instructions)) asked.push(x.instructions);
          const broken = /complies with this rule/.test(x.instructions) && /em dash/.test(x.instructions) && text.includes('—');
          return [k, { type: 'noul' as const, p: broken ? 0.05 : 0.95 }];
        }),
      );
      return { ok: true, backend: 'fake', latencyMs: 1, answers };
    },
  });
  const host = (posted: { repo: string; post: ForgePost }[], asked: string[] = [], configs: Record<string, RepoConfig> = {}) => ({
    forge: fakeForge({
      name: 'GitHub',
      writes: GH_WRITES,
      nouns: github.nouns,
      contents: async (repo) => Object.keys(docs[repo] ?? {}),
      file: async (repo, path) => docs[repo]?.[path],
      post: async (repo, post) => {
        posted.push({ repo, post });
        return `https://github.com/${repo}/${post.kind}/1`;
      },
    }),
    judge: judge(asked),
    store: memoryStore(),
    now: () => 1,
    notice: () => undefined,
    config: async (repo: string) => configs[repo] ?? DEFAULT_CONFIG,
  });
  const pack = BUILTIN_PACKS['rules']!;

  it('judges the text by the rules of the repository it names and writes it there', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const asked: string[] = [];
    const r = await postCall(host(posted, asked), pack, { repo: 'o/target', kind: 'pr-comment', number: 4, body: 'Looks right, merging.' });
    expect(r).toMatchObject({ url: 'https://github.com/o/target/pr/1', outbound: { channel: 'github-pr-comment', kind: 'a comment on a pull request' }, decision: { allow: true } });
    expect(posted).toEqual([{ repo: 'o/target', post: { kind: 'pr', action: 'comment', number: 4, body: 'Looks right, merging.' } }]);
    expect(asked.some((q) => /em dash/.test(q))).toBe(true);
    expect(asked.some((q) => /haiku/.test(q))).toBe(false);
  });

  it('refuses a broken rule and writes nothing, and only logs it in shadow', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const input = { repo: 'o/target', kind: 'issue-create', title: 'Watcher misses edits', body: 'It drops them — every time.' };
    const r = await postCall(host(posted), pack, input);
    expect(r).toMatchObject({ refused: expect.stringMatching(/^github-issue-create to o\/target: breaks: Prose: No em dashes/) });
    expect(posted).toEqual([]);
    const shadow = await postCall(host(posted), pack, input, true);
    expect(shadow).toMatchObject({ url: 'https://github.com/o/target/issue/1', decision: { allow: false } });
    expect(posted).toHaveLength(1);
  });

  it('holds the text to the named repository\'s channel limit', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const config = resolveConfig([{ outbound: { channels: [{ name: 'github-pr-comment', tool: '^mcp__sift__post$', text: { fields: ['body'], when: { kind: 'pr-comment' } }, limit: 10, kind: 'a comment on a pull request' }] } }]);
    const r = await postCall(host(posted, [], { 'o/target': config }), pack, { repo: 'o/target', kind: 'pr-comment', number: 4, body: 'eleven chars' });
    expect(r).toMatchObject({ refused: 'github-pr-comment to o/target: github-pr-comment text is 12 chars, the limit is 10' });
    expect(posted).toEqual([]);
    expect(await postCall(host(posted, [], { 'o/target': config }), pack, { repo: 'o/other', kind: 'pr-comment', number: 4, body: 'eleven chars' })).toMatchObject({ url: 'https://github.com/o/other/pr/1' });
  });

  it('writes a textless merge without a judge call, and refuses bad input before any read', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const asked: string[] = [];
    expect(await postCall(host(posted, asked), pack, { repo: 'o/target', kind: 'pr-merge', number: 4, method: 'merge' })).toEqual({ outbound: undefined, decision: undefined, url: 'https://github.com/o/target/pr/1' });
    expect(asked).toEqual([]);
    expect(await postCall(host(posted), pack, { repo: 'o/target', kind: 'pr-merge', number: 4 })).toEqual({ refused: 'pr-merge needs method, one of merge, squash, rebase' });
    expect(posted).toHaveLength(1);
  });
});
