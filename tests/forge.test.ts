import { describe, expect, it } from 'vitest';
import { GitHubForge } from '../src/forge/github.ts';

type Reply = { status?: number; body?: unknown; etag?: string };

// a gh that answers each api path from a table; a --jq page answers the body alone
function github(table: Record<string, Reply | ((argv: readonly string[]) => Reply)>, calls: string[] = []): GitHubForge {
  return new GitHubForge(async (argv) => {
    const path = argv[argv.length - 1]!;
    calls.push(argv.join(' '));
    const key = Object.keys(table).find((k) => path.startsWith(k));
    const hit = key === undefined ? undefined : table[key]!;
    const reply = typeof hit === 'function' ? hit(argv) : hit;
    if (!reply) return { exitCode: 1, stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}', stderr: '' };
    const body = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    if (argv[2] === '--jq') return { exitCode: 0, stdout: body, stderr: '' };
    return { exitCode: 0, stdout: `HTTP/2.0 ${reply.status ?? 200} OK\r\nEtag: ${reply.etag ?? '"e"'}\r\nX-Ratelimit-Remaining: 4000\r\n\r\n${body}`, stderr: '' };
  });
}

describe('github forge', () => {
  it('merges check runs and commit statuses into one list of checks', async () => {
    const forge = github({
      'repos/o/r/commits/abc/check-runs': { body: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'in_progress', conclusion: null }, { name: 'lint', status: 'completed', conclusion: 'timed_out' }] } },
      'repos/o/r/commits/abc/status': { body: { statuses: [{ context: 'ext', state: 'pending' }, { context: 'cov', state: 'error' }] } },
    });
    expect(await forge.checks('o/r', 'abc')).toEqual([
      { name: 'build', done: true, conclusion: 'success', ok: true },
      { name: 'test', done: false, conclusion: null, ok: false },
      { name: 'lint', done: true, conclusion: 'timed_out', ok: false },
      { name: 'ext', done: false, conclusion: null, ok: false },
      { name: 'cov', done: true, conclusion: 'error', ok: false },
    ]);
  });

  it('reads items conditionally: a probe that has not moved answers unchanged, else the pages since the stamp', async () => {
    const calls: string[] = [];
    let moved = false;
    const forge = github(
      {
        'repos/o/r/issues?state=all&sort=updated&direction=desc': () => (moved ? { body: [{ number: 2 }], etag: '"f"' } : { status: 304, body: '' }),
        'repos/o/r/issues?state=all&sort=updated&direction=asc': { body: [{ n: 2, t: 'Two', s: 'open', u: 'dep[bot]', bl: 3, bp: 'abc', c: 1, l: 'bug,p1', up: '2', cr: '1', url: 'u', pr: true, m: false }] },
      },
      calls,
    );
    expect(await forge.items('o/r', '2026-01-01T00:00:00Z', '"e"')).toEqual({ changed: false, rate: { remaining: 4000, reset: undefined } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('If-None-Match: "e"');
    moved = true;
    const read = await forge.items('o/r', '2026-01-01T00:00:00Z', '"e"');
    expect(read).toMatchObject({ changed: true, token: '"f"' });
    expect(read.changed && read.value).toEqual([{ kind: 'pr', number: 2, title: 'Two', state: 'open', author: { login: 'dep[bot]', bot: true }, body: { length: 3, head: 'abc' }, comments: 1, labels: ['bug', 'p1'], updatedAt: '2', createdAt: '1', url: 'u', merged: false }]);
    expect(calls[2]).toContain('since=2026-01-01T00:00:00Z');
  });

  it('treats a repository without actions as one whose runs never change', async () => {
    const forge = github({ 'repos/o/r/actions/runs': { status: 403, body: { message: 'no' } } });
    expect(await forge.runs('o/r')).toEqual({ changed: false, rate: {} });
    const withRuns = github({ 'repos/o/r/actions/runs': { body: { workflow_runs: [{ id: 7, name: 'ci', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'skipped', head_sha: 'abc', html_url: 'u', actor: { login: 'a' }, updated_at: '1' }] }, etag: '"r"' } });
    expect(await withRuns.runs('o/r')).toMatchObject({ changed: true, token: '"r"', value: [{ id: '7', name: 'ci', done: true, conclusion: 'skipped', ok: true, branch: 'main', sha: 'abc', actor: 'a' }] });
  });

  it('finds templates in every documented location and skips the issue form chooser', async () => {
    const entry = (path: string, type = 'file') => ({ name: path.split('/').pop()!, path, type });
    const forge = github({
      'repos/o/r/contents/.github/ISSUE_TEMPLATE/': (argv) => ({ body: `# ${argv[argv.length - 1]!.split('/').pop()}` }),
      'repos/o/r/contents/.github/ISSUE_TEMPLATE': { body: [entry('.github/ISSUE_TEMPLATE/bug.yml'), entry('.github/ISSUE_TEMPLATE/config.yml'), entry('.github/ISSUE_TEMPLATE/feature.md')] },
      'repos/o/r/contents/.github/PULL_REQUEST_TEMPLATE.md': { body: '# pr' },
      'repos/o/r/contents/.github': { body: [entry('.github/ISSUE_TEMPLATE', 'dir'), entry('.github/PULL_REQUEST_TEMPLATE.md'), entry('.github/workflows', 'dir')] },
      'repos/o/r/contents/docs/pull_request_template.md': { body: '# docs pr' },
      'repos/o/r/contents/docs': { body: [entry('docs/pull_request_template.md')] },
      'repos/o/r/contents/': { body: [entry('README.md'), entry('docs', 'dir'), entry('.github', 'dir')] },
    });
    expect(await forge.templates('o/r')).toEqual([
      { kind: 'pr', name: 'docs/pull_request_template.md', body: '# docs pr' },
      { kind: 'issue', name: '.github/ISSUE_TEMPLATE/bug.yml', body: '# bug.yml' },
      { kind: 'issue', name: '.github/ISSUE_TEMPLATE/feature.md', body: '# feature.md' },
      { kind: 'pr', name: '.github/PULL_REQUEST_TEMPLATE.md', body: '# pr' },
    ]);
  });

  it('lists every file at a ref from the recursive tree, the default branch when none is named', async () => {
    const calls: string[] = [];
    const forge = github(
      {
        'repos/o/r/git/trees/': { body: { tree: [{ path: 'README.md', type: 'blob' }, { path: 'docs', type: 'tree' }, { path: 'docs/a.md', type: 'blob' }] } },
        'repos/o/r': { body: { default_branch: 'main' } },
      },
      calls,
    );
    expect(await forge.contents('o/r')).toEqual(['README.md', 'docs/a.md']);
    expect(calls[1]).toContain('repos/o/r/git/trees/main?recursive=1');
    await forge.contents('o/r', 'feat/1');
    expect(calls[2]).toContain('repos/o/r/git/trees/feat%2F1?recursive=1');
  });

  it('reads the closing relation from the pull request', async () => {
    const calls: string[] = [];
    const forge = github({ graphql: { body: { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 4 }, { number: 9 }] } } } } } } }, calls);
    expect(await forge.closingIssues('o/r', 7)).toEqual([4, 9]);
    expect(calls[0]).toContain('pullRequest(number: 7)');
  });

  it('lists the artifact writes gh makes with their body flags', () => {
    const { writes } = github({});
    expect(writes.map((w) => `${w.kind} ${w.action}`)).toEqual(['pr create', 'pr comment', 'pr edit', 'issue create', 'issue comment', 'issue edit', 'release create', 'release edit']);
    const comment = writes.find((w) => w.kind === 'pr' && w.action === 'comment')!;
    expect(comment).toMatchObject({ body: ['--body', '-b'], file: ['--body-file', '-F'] });
    expect(new RegExp(comment.command).test('gh pr comment 3 -b x')).toBe(true);
    expect(new RegExp(comment.command).test('gh pr view 5')).toBe(false);
    expect(writes.find((w) => w.kind === 'release' && w.action === 'create')).toMatchObject({ body: ['--notes', '-n'], file: ['--notes-file', '-F'] });
  });
});
