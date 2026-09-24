import { describe, expect, it } from 'vitest';
import { CONTEXT_ROOM, textTokens } from '../src/judge/room.ts';
import type { ForgePost } from '../src/forge/forge.ts';
import { GitHubForge, GH_WRITES } from '../src/forge/github.ts';
import type { Judge } from '../src/judge/types.ts';
import { postCall, postOf, rawWriteOf, rawWriteRefusal } from '../src/gate/post.ts';
import { fallbackNote, gateShellWrite } from '../src/gate/shell.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import type { Checkout } from '../src/repo/checkout.ts';
import { DEFAULT_CONFIG, resolveConfig, type RepoConfig } from '../src/repo/config.ts';
import { simpleCommands } from '../src/shell.ts';
import { fakeForge } from './fake-forge.ts';
import { discoveries } from './fake-source.ts';

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
  const host = (posted: { repo: string; post: ForgePost }[], asked: string[] = [], configs: Record<string, RepoConfig> = {}, j: Judge = judge(asked)) => ({
    forge: fakeForge({
      name: 'GitHub',
      writes: GH_WRITES,
      nouns: github.nouns,
      contents: async (repo) => Object.keys(docs[repo] ?? {}).map((path) => ({ path, id: path })),
      file: async (repo, path) => docs[repo]?.[path],
      post: async (repo, post) => {
        posted.push({ repo, post });
        return `https://github.com/${repo}/${post.kind}/1`;
      },
    }),
    judge: j,
    discoveries: discoveries(j),
    config: async (repo: string) => configs[repo] ?? DEFAULT_CONFIG,
  });
  const pack = BUILTIN_PACKS['rules']!;

  it('judges the text by the rules of the repository it names and writes it there', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const asked: string[] = [];
    const r = await postCall(host(posted, asked), pack, { repo: 'o/target', kind: 'pr-comment', number: 4, body: 'Looks right, merging.' }, 'enforce');
    expect(r).toMatchObject({ url: 'https://github.com/o/target/pr/1', outbound: { channel: 'github-pr-comment', kind: 'a comment on a pull request' }, decision: { allow: true } });
    expect(posted).toEqual([{ repo: 'o/target', post: { kind: 'pr', action: 'comment', number: 4, body: 'Looks right, merging.' } }]);
    expect(asked.some((q) => /em dash/.test(q))).toBe(true);
    expect(asked.some((q) => /haiku/.test(q))).toBe(false);
  });

  it('refuses a broken rule and writes nothing, and only logs it in shadow', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const input = { repo: 'o/target', kind: 'issue-create', title: 'Watcher misses edits', body: 'It drops them — every time.' };
    const r = await postCall(host(posted), pack, input, 'enforce');
    expect(r).toMatchObject({ refused: expect.stringMatching(/^github-issue-create to o\/target: breaks: Prose: No em dashes/) });
    expect(posted).toEqual([]);
    const shadow = await postCall(host(posted), pack, input, 'enforce', true);
    expect(shadow).toMatchObject({ url: 'https://github.com/o/target/issue/1', decision: { allow: false } });
    expect(posted).toHaveLength(1);
  });

  it('holds the text to the named repository\'s channel limit', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const config = resolveConfig([{ outbound: { channels: [{ name: 'github-pr-comment', tool: '^mcp__sift__post$', text: { fields: ['body'], when: { kind: 'pr-comment' } }, limit: 10, kind: 'a comment on a pull request' }] } }]);
    const r = await postCall(host(posted, [], { 'o/target': config }), pack, { repo: 'o/target', kind: 'pr-comment', number: 4, body: 'eleven chars' }, 'enforce');
    expect(r).toMatchObject({ refused: 'github-pr-comment to o/target: github-pr-comment text is 12 chars, the limit is 10' });
    expect(posted).toEqual([]);
    expect(await postCall(host(posted, [], { 'o/target': config }), pack, { repo: 'o/other', kind: 'pr-comment', number: 4, body: 'eleven chars' }, 'enforce')).toMatchObject({ url: 'https://github.com/o/other/pr/1' });
  });

  it('writes a textless merge without a judge call, and refuses bad input before any read', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const asked: string[] = [];
    expect(await postCall(host(posted, asked), pack, { repo: 'o/target', kind: 'pr-merge', number: 4, method: 'merge' }, 'enforce')).toEqual({ outbound: undefined, decision: undefined, url: 'https://github.com/o/target/pr/1' });
    expect(asked).toEqual([]);
    expect(await postCall(host(posted), pack, { repo: 'o/target', kind: 'pr-merge', number: 4 }, 'enforce')).toEqual({ refused: 'pr-merge needs method, one of merge, squash, rebase' });
    expect(posted).toHaveLength(1);
  });

  it('refuses and writes nothing while the named repository\'s rule discovery outlasts its wait', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const never: Judge = { name: 'never', ask: () => new Promise(() => {}) };
    const h = { ...host(posted, [], {}, never), discoveries: discoveries(never, undefined, { schedule: (_, fn) => (void Promise.resolve().then(fn), { cancel: () => {} }) }) };
    const r = await postCall(h, pack, { repo: 'o/target', kind: 'pr-comment', number: 4, body: 'Looks right.' }, 'enforce');
    expect(r).toMatchObject({ refused: 'github-pr-comment to o/target: rule discovery for o/target outlasted its 5 s wait and keeps running; the next call on it reuses what it finds', decision: { allow: false, pending: true } });
    expect(posted).toEqual([]);
  });

  it('writes with no judge call under off', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const asked: string[] = [];
    const r = await postCall(host(posted, asked), pack, { repo: 'o/target', kind: 'issue-create', title: 'Watcher misses edits', body: 'It drops them — every time.' }, 'off');
    expect(r).toEqual({ url: 'https://github.com/o/target/issue/1' });
    expect(asked).toEqual([]);
    expect(posted).toHaveLength(1);
  });

  it('writes under advise whatever the verdict, and carries the verdict back', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const broken = await postCall(host(posted), pack, { repo: 'o/target', kind: 'issue-create', title: 'Watcher misses edits', body: 'It drops them — every time.' }, 'advise');
    expect(broken).toMatchObject({ url: 'https://github.com/o/target/issue/1', action: 'advise', verdict: expect.stringMatching(/^sift outbound \(github-issue-create\), note: this may break Prose: No em dashes/) });
    const clear = await postCall(host(posted), pack, { repo: 'o/target', kind: 'pr-comment', number: 4, body: 'Looks right, merging.' }, 'advise');
    expect(clear).toMatchObject({ url: 'https://github.com/o/target/pr/1', action: 'allow', verdict: 'sift outbound (github-pr-comment): clear' });
    const config = resolveConfig([{ outbound: { channels: [{ name: 'github-pr-comment', tool: '^mcp__sift__post$', text: { fields: ['body'], when: { kind: 'pr-comment' } }, limit: 10, kind: 'a comment on a pull request' }] } }]);
    const long = await postCall(host(posted, [], { 'o/target': config }), pack, { repo: 'o/target', kind: 'pr-comment', number: 4, body: 'eleven chars' }, 'advise');
    expect(long).toMatchObject({ action: 'advise', verdict: 'sift outbound (github-pr-comment), note: github-pr-comment text is 12 chars, the limit is 10' });
    expect(posted).toHaveLength(3);
  });

  it('writes a refused post under enforce when override gives a reason, and refuses an override without one', async () => {
    const posted: { repo: string; post: ForgePost }[] = [];
    const input = { repo: 'o/target', kind: 'issue-create', title: 'Watcher misses edits', body: 'It drops them — every time.' };
    const r = await postCall(host(posted), pack, { ...input, override: ' the dash is quoted from the log ' }, 'enforce');
    expect(r).toMatchObject({ url: 'https://github.com/o/target/issue/1', action: 'override', override: 'the dash is quoted from the log', decision: { allow: false }, outbound: { text: 'Watcher misses edits\nIt drops them — every time.' } });
    expect((r as { verdict: string }).verdict).toMatch(/written over the ruling \(breaks: Prose: No em dashes.*\), override: the dash is quoted from the log$/);
    for (const override of ['', '  ', 3]) expect(await postCall(host(posted), pack, { ...input, override }, 'enforce')).toEqual({ refused: `override is the reason the write goes through over the ruling, got ${JSON.stringify(override)}` });
    expect(posted).toHaveLength(1);
  });

  describe('a shell write from a loop that cannot call post', () => {
    const fs = { read: async () => '', exists: async () => false, list: async () => [], stat: async () => ({}) } as never;
    const at = async (): Promise<Checkout> => ({ root: '/w', repo: 'o/target', config: DEFAULT_CONFIG, packs: { rules: pack } });
    const noRead = async (p: string): Promise<string> => {
      throw new Error(`no file ${p}`);
    };
    const shell = (asked: string[] = []) => ({ ...host([], asked), fs });
    const write = { kind: 'pr', action: 'comment' } as const;
    const bash = (command: string) => ({ command });

    it('is refused toward post when the loop can call it', async () => {
      const r = await gateShellWrite(shell(), write, true, 'enforce', at, bash('gh pr comment 4 -b "fine"'), noRead);
      expect(r).toEqual({ write, fallback: false, refused: rawWriteRefusal(shell().forge, write) });
    });

    it('is judged on its text by the checkout\'s rules, allowed or refused on it', async () => {
      const asked: string[] = [];
      const ok = await gateShellWrite(shell(asked), write, false, 'enforce', at, bash('gh pr comment 4 --body "Looks right, merging."'), noRead);
      expect(ok).toMatchObject({ fallback: true, gated: { outbound: { channel: 'github-shell-pr-comment', text: 'Looks right, merging.' }, decision: { allow: true } } });
      expect(asked.some((q) => /em dash/.test(q))).toBe(true);
      const heredoc = `gh pr comment 4 --body-file - <<'EOF'\nIt drops them — every time.\nEOF`;
      const broken = await gateShellWrite(shell(), write, false, 'enforce', at, bash(heredoc), noRead);
      expect(broken).toMatchObject({ fallback: true, gated: { outbound: { channel: 'github-shell-pr-comment' }, decision: { allow: false, reason: expect.stringMatching(/No em dashes/) } } });
      const created = await gateShellWrite(shell(), { kind: 'issue', action: 'create' }, false, 'enforce', at, bash('gh issue new -t "Watcher misses edits" -b "It drops them."'), noRead);
      expect(created).toMatchObject({ gated: { outbound: { channel: 'github-shell-issue-create' }, decision: { allow: true } } });
    });

    it('is judged on its text under advise even when the loop can call post, and says so when its text cannot be read', async () => {
      const ok = await gateShellWrite(shell(), write, true, 'advise', at, bash('gh pr comment 4 --body "It drops them — every time."'), noRead);
      expect(ok).toMatchObject({ fallback: false, gated: { outbound: { channel: 'github-shell-pr-comment' }, decision: { allow: false, reason: expect.stringMatching(/No em dashes/) } } });
      const unread = await gateShellWrite(shell(), write, true, 'advise', at, bash('gh api repos/o/target/issues/4/comments -f body=hi'), noRead);
      expect(unread).toMatchObject({ fallback: false, unread: expect.stringContaining('its text could not be read from the command, so it was not judged') });
    });

    it('names the fallback when the text cannot be read, and when it judged', async () => {
      const r = await gateShellWrite(shell(), write, false, 'enforce', at, bash('gh api repos/o/target/issues/4/comments -f body=hi'), noRead);
      expect(r).toMatchObject({ fallback: true, refused: expect.stringContaining('this loop started before sift registered mcp__sift__post, so it cannot call it') });
      expect((r as { refused: string }).refused).toContain('--body-file');
      expect(fallbackNote(shell().forge)).toMatch(/judged on its text by the checkout's rules instead of refused/);
    });
  });

  describe('a text longer than the judge reads at once', () => {
    const rulesDocs: Record<string, Record<string, string>> = {
      'o/long': { 'CONTRIBUTING.md': '## Prose\n\nNo em dashes in anything you write.\n\n## Releases\n\nRelease notes state the SemVer impact.\n' },
    };
    // a judge that follows each rule question's criteria: an em dash breaks the prose rule wherever it is, and the
    // SemVer rule, a rule about the whole text, is broken only by a whole-text question on text that never states it
    type Seen = { text: string; kind: string; instructions: string[]; criteria: string[] };
    const judge = (seen: Seen[]): Judge => ({
      name: 'fake',
      ask: async (state, q) => {
        const subject = (state as Record<string, unknown>)['subject'] as { text?: string; kind?: string } | undefined;
        const text = subject?.text ?? '';
        if (subject) seen.push({ text, kind: subject.kind ?? '', instructions: Object.values(q).map((x) => x.instructions), criteria: Object.values(q).map((x) => (x.type === 'noul' && x.criteria ? x.criteria.true : '')) });
        const answers = Object.fromEntries(
          Object.entries(q).map(([k, x]) => {
            const whole = / complies with this rule: /.test(x.instructions);
            const broken = subject !== undefined && ((/em dash/.test(x.instructions) && text.includes('—')) || (whole && /SemVer/.test(x.instructions) && !text.includes('SemVer impact:')));
            return [k, { type: 'noul' as const, p: broken ? 0.05 : 0.95 }];
          }),
        );
        return { ok: true, backend: 'fake', latencyMs: 1, answers };
      },
    });
    const longHost = (posted: { repo: string; post: ForgePost }[], seen: Seen[]) => ({
      ...host(posted, [], {}, judge(seen)),
      forge: fakeForge({
        name: 'GitHub',
        writes: GH_WRITES,
        nouns: github.nouns,
        contents: async (repo) => Object.keys(rulesDocs[repo] ?? {}).map((path) => ({ path, id: path })),
        file: async (repo, path) => rulesDocs[repo]?.[path],
        post: async (repo, post) => {
          posted.push({ repo, post });
          return `https://github.com/${repo}/${post.kind}/1`;
        },
      }),
    });
    // release notes of 150,000 characters in headed sections of numbered paragraphs, the impact stated only at the top,
    // with an em dash placed after character 100,000 when broken
    const notes = (broken: boolean): string => {
      let body = 'SemVer impact: minor.\n\n';
      for (let n = 0; body.length < 150_000; n++) {
        if (n % 10 === 0) body += `## Section ${n / 10}\n\n`;
        body += `Paragraph ${n} describes one change in plain words and nothing more than that, at some length. `.repeat(3) + '\n\n';
      }
      body = body.slice(0, 150_000);
      if (!broken) return body;
      const at = body.indexOf('\n\n', 100_000);
      return `${body.slice(0, at)} This line has one — dash.${body.slice(at)}`;
    };
    const post = (body: string) => ({ repo: 'o/long', kind: 'release-create', tag: 'v1.0.0', title: 'v1.0.0', body });

    it('refuses a rule broken after character 100,000, naming the part', async () => {
      const posted: { repo: string; post: ForgePost }[] = [];
      const seen: Seen[] = [];
      const body = notes(true);
      expect(body.length).toBeGreaterThan(150_000);
      expect(body.indexOf('—')).toBeGreaterThan(100_000);
      const r = await postCall(longHost(posted, seen), pack, post(body), 'enforce');
      expect(r).toMatchObject({ refused: expect.stringMatching(/^github-release-create to o\/long: breaks: Prose: No em dashes in anything you write\. \(in part [2-9] of \d \("Section \d+"( to "Section \d+")?\)\)$/) });
      expect(posted).toEqual([]);
    });

    it('allows the same text without the violation, the judge having read every character', async () => {
      const posted: { repo: string; post: ForgePost }[] = [];
      const seen: Seen[] = [];
      const body = notes(false);
      const r = await postCall(longHost(posted, seen), pack, post(body), 'enforce');
      expect(r).toMatchObject({ url: 'https://github.com/o/long/release/1', decision: { allow: true, reason: 'clear' } });
      expect(r.decision?.report?.parts?.length).toBeGreaterThan(1);
      // the post's text is its title and body joined; the parts the judge read, in order, are exactly that text
      const text = `v1.0.0\n${body}`;
      const read = [...seen].sort((a, b) => text.indexOf(a.text) - text.indexOf(b.text));
      expect(read.map((s) => s.text).join('')).toBe(text);
      expect(read.every((s) => textTokens(s.text) <= CONTEXT_ROOM)).toBe(true);
    });

    it('judges a whole-text rule on the opening alone, so later parts need not satisfy it', async () => {
      const posted: { repo: string; post: ForgePost }[] = [];
      const seen: Seen[] = [];
      const r = await postCall(longHost(posted, seen), pack, post(notes(false)), 'enforce');
      expect(r).toMatchObject({ decision: { allow: true, warnings: [] } });
      const [opening, ...later] = [...seen].sort((a, b) => Number(b.text.startsWith('v1.0.0')) - Number(a.text.startsWith('v1.0.0')));
      expect(opening!.kind).toBe('text');
      expect(opening!.instructions.some((i) => /^The opening, part 1 of \d+ \("Section 0" to "Section \d+"\), of the subject \(the title and notes of a new GitHub release\) complies with this rule: Releases: Release notes state the SemVer impact\.$/.test(i))).toBe(true);
      expect(later.length).toBeGreaterThan(0);
      for (const part of later) {
        expect(part.text.includes('SemVer impact:')).toBe(false);
        expect(part.kind).toBe('section');
        expect(part.instructions.every((i) => / of the subject \(the title and notes of a new GitHub release\) does not break this rule: /.test(i))).toBe(true);
        expect(part.criteria.every((c) => /judged on the opening of the text: a part without it does not break it/.test(c))).toBe(true);
      }
      // the same notes with the impact missing are refused at the opening
      const missing = await postCall(longHost(posted, []), pack, post(notes(false).replace('SemVer impact: minor.', 'Impact: minor.')), 'enforce');
      expect(missing).toMatchObject({ refused: expect.stringMatching(/breaks: Releases: Release notes state the SemVer impact\. \(in the opening, part 1 of \d+/) });
    });
  });
});
