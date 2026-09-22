import { describe, expect, it } from 'vitest';
import { GitHubForge, splitJobLog, templateKind } from '../src/forge/github.ts';
import { MACH_CI, MACH_JOBS, MACH_RUN } from './fixtures/mach-ci.ts';

type Reply = { status?: number; body?: unknown; etag?: string; headers?: string[] };

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
    const headers = reply.headers ?? [`Etag: ${reply.etag ?? '"e"'}`, 'X-Ratelimit-Remaining: 4000'];
    return { exitCode: 0, stdout: `HTTP/2.0 ${reply.status ?? 200} OK\r\n${headers.join('\r\n')}\r\n\r\n${body}`, stderr: '' };
  });
}

describe('github forge', () => {
  it('merges check runs and commit statuses into one list of checks', async () => {
    const forge = github({
      'repos/o/r/commits/abc/check-runs': { body: { check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }, { id: 2, name: 'test', status: 'in_progress', conclusion: null }, { id: 3, name: 'lint', status: 'completed', conclusion: 'timed_out' }] } },
      'repos/o/r/commits/abc/status': { body: { statuses: [{ context: 'ext', state: 'pending' }, { context: 'cov', state: 'error' }] } },
    });
    expect(await forge.checks('o/r', 'abc')).toEqual([
      { name: 'build', id: '1', done: true, conclusion: 'success', ok: true },
      { name: 'test', id: '2', done: false, conclusion: null, ok: false },
      { name: 'lint', id: '3', done: true, conclusion: 'timed_out', ok: false },
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

  it('marks a run whose ref is a tag, looking each ref name up once, and reads one run by id', async () => {
    const calls: string[] = [];
    const raw = (id: number, branch: string, event: string) => ({ id, name: 'ci', head_branch: branch, event, status: 'completed', conclusion: 'success', head_sha: 'abc', html_url: 'u', actor: { login: 'a' }, updated_at: '1' });
    const forge = github(
      {
        'repos/o/r/actions/runs/9': { body: raw(9, 'v1.2.0', 'push') },
        'repos/o/r/actions/runs': { body: { workflow_runs: [raw(7, 'v1.2.0', 'push'), raw(8, 'main', 'push'), raw(6, 'feat/1', 'pull_request'), raw(5, 'v1.2.0', 'release'), raw(4, 'v1', 'push')] } },
        'repos/o/r/git/matching-refs/tags/v1.2.0': { body: [{ ref: 'refs/tags/v1.2.0' }] },
        // matching-refs matches by prefix: only an exact ref is the tag
        'repos/o/r/git/matching-refs/tags/v1': { body: [{ ref: 'refs/tags/v1.2.0' }] },
        'repos/o/r/git/matching-refs/tags/main': { body: [] },
      },
      calls,
    );
    const read = await forge.runs('o/r');
    expect(read.changed && read.value.map((r) => [r.id, r.tag])).toEqual([['7', true], ['8', false], ['6', false], ['5', true], ['4', false]]);
    expect(await forge.run('o/r', '9')).toMatchObject({ id: '9', branch: 'v1.2.0', tag: true, done: true });
    expect(calls.filter((c) => c.includes('matching-refs')).map((c) => c.split('/').slice(-1)[0])).toEqual(['v1.2.0', 'main', 'v1']);
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

  it('names the kind of template at every documented location and nowhere else', () => {
    expect(templateKind('ISSUE_TEMPLATE.md')).toBe('issue');
    expect(templateKind('docs/issue_template.yml')).toBe('issue');
    expect(templateKind('.github/ISSUE_TEMPLATE/bug.yaml')).toBe('issue');
    expect(templateKind('ISSUE_TEMPLATE/feature.md')).toBe('issue');
    expect(templateKind('PULL_REQUEST_TEMPLATE.md')).toBe('pr');
    expect(templateKind('.github/pull_request_template.md')).toBe('pr');
    expect(templateKind('docs/PULL_REQUEST_TEMPLATE/feature.md')).toBe('pr');
    expect(templateKind('.github/ISSUE_TEMPLATE/config.yml')).toBeUndefined();
    expect(templateKind('.github/PULL_REQUEST_TEMPLATE/a.yml')).toBeUndefined();
    expect(templateKind('PULL_REQUEST_TEMPLATE.yml')).toBeUndefined();
    expect(templateKind('src/ISSUE_TEMPLATE.md')).toBeUndefined();
    expect(templateKind('a/.github/ISSUE_TEMPLATE/bug.md')).toBeUndefined();
    expect(templateKind('.github/workflows/ci.yml')).toBeUndefined();
    expect(templateKind('README.md')).toBeUndefined();
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
    expect(writes.map((w) => `${w.kind} ${w.action}`)).toEqual(['pr create', 'pr comment', 'pr edit', 'pr review', 'pr merge', 'issue create', 'issue comment', 'issue edit', 'release create', 'release edit']);
    const comment = writes.find((w) => w.kind === 'pr' && w.action === 'comment')!;
    expect(comment).toMatchObject({ body: ['--body', '-b'], file: ['--body-file', '-F'] });
    expect(new RegExp(comment.command).test('gh pr comment 3 -b x')).toBe(true);
    expect(new RegExp(comment.command).test('gh pr view 5')).toBe(false);
    expect(writes.find((w) => w.kind === 'release' && w.action === 'create')).toMatchObject({ body: ['--notes', '-n'], file: ['--notes-file', '-F'] });
    const review = writes.find((w) => w.kind === 'pr' && w.action === 'review')!;
    expect(review).toMatchObject({ body: ['--body', '-b'], file: ['--body-file', '-F'] });
    expect(new RegExp(review.command).test('gh pr review 3 --approve -b x')).toBe(true);
    expect(new RegExp(review.command).test('gh pr reviews 3')).toBe(false);
    const merge = writes.find((w) => w.kind === 'pr' && w.action === 'merge')!;
    expect(merge).toMatchObject({ body: ['--body', '-b'], file: ['--body-file', '-F'] });
    expect(new RegExp(merge.command).test('gh pr merge 3 --merge --body x')).toBe(true);
  });

  it('reads a job log under gh\'s default accept from the download it is redirected to and splits it at the runner\'s step marks', async () => {
    const calls: string[] = [];
    const log = [
      '\uFEFF2026-09-21T02:35:09.9377426Z Current runner version: 2.337.0',
      '2026-09-21T02:35:10.6877018Z ##[group]Run actions/checkout@v6',
      '2026-09-21T02:35:10.6889601Z ##[endgroup]',
      '2026-09-21T02:35:10.7940015Z ##[group]Getting Git version info',
      '2026-09-21T02:35:10.8094836Z ##[endgroup]',
      '2026-09-21T02:35:32.9188808Z ##[group]Run set -euo pipefail',
      '2026-09-21T02:35:32.9189137Z \u001b[36;1mset -euo pipefail\u001b[0m',
      '2026-09-21T02:35:32.9239413Z ##[endgroup]',
      '2026-09-21T02:38:09.8202143Z FAIL x86_64-linux vec/load_literal golden: line 594,595c594',
      '2026-09-21T02:47:54.6635256Z ##[error]Process completed with exit code 1.',
      '2026-09-21T02:47:54.6774571Z Post job cleanup.',
      '2026-09-21T02:47:54.9609986Z Cleaning up orphan processes',
    ].join('\n');
    const forge = github(
      {
        // the logs endpoint answers a 302 that gh follows, so the response printed is the blob store's: text/plain, no api headers
        'repos/o/r/actions/jobs/7/logs': { body: log, headers: ['Content-Type: text/plain', 'Content-Length: 19481', 'Server: Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0'] },
        'repos/o/r/actions/jobs/7': { body: { id: 7, run_id: 3, head_sha: 'abc', name: 'codegen', status: 'completed', conclusion: 'failure', html_url: 'https://x/job/7' } },
        'repos/o/r/actions/runs/3/jobs': { body: [{ id: 7, run_id: 3, head_sha: 'abc', name: 'codegen', status: 'completed', conclusion: 'failure', html_url: 'https://x/job/7' }] },
        // a run record without a workflow path: nothing to read needs from
        'repos/o/r/actions/runs/3': { body: { id: 3, head_sha: 'abc' } },
      },
      calls,
    );
    const read = await forge.jobLog('o/r', '7');
    expect(read).toMatchObject({ job: 'codegen', run: '3', sha: 'abc', url: 'https://x/job/7' });
    expect(read.steps.map((s) => [s.name, s.ok])).toEqual([
      ['Set up job', true],
      ['Run actions/checkout@v6', true],
      ['Run set -euo pipefail', false],
      ['Post job cleanup', true],
    ]);
    expect(read.steps[2]!.text).toContain('FAIL x86_64-linux');
    expect(read.steps[2]!.text).not.toContain('Cleaning up');
    const logsCall = calls.find((c) => c.includes('/logs'))!;
    expect(logsCall).toContain('--allow-escape-sequences');
    expect(logsCall).not.toContain('Accept:');
    expect(await forge.jobs('o/r', '3')).toEqual([{ id: '7', name: 'codegen', run: '3', sha: 'abc', done: true, conclusion: 'failure', ok: false, url: 'https://x/job/7' }]);
    expect(splitJobLog('')).toEqual([]);
  });

  it('fills each job\'s needs from the workflow file at the run\'s sha, matrix and skipped jobs included', async () => {
    const calls: string[] = [];
    const sha = '40d626492bb65d0cbe06344b258df3510a84923a';
    const forge = github(
      {
        [`repos/o/r/actions/runs/${MACH_RUN}/jobs`]: { body: MACH_JOBS },
        [`repos/o/r/actions/runs/${MACH_RUN}`]: { body: { id: MACH_RUN, head_sha: sha, path: '.github/workflows/ci.yml' } },
        [`repos/o/r/contents/.github/workflows/ci.yml?ref=${sha}`]: { body: MACH_CI },
      },
      calls,
    );
    const jobs = await forge.jobs('o/r', String(MACH_RUN));
    const ids = (...names: string[]): string[] => jobs.filter((j) => names.includes(j.name)).map((j) => j.id);
    const needs = (name: string): string[] | undefined => jobs.find((j) => j.name === name)!.needs;
    const builds = ids('build x86_64-windows', 'build aarch64-linux', 'build x86_64-linux');
    expect(builds).toHaveLength(3);
    expect(needs('build x86_64-linux')).toEqual([]);
    expect(needs('docs')).toEqual(builds);
    expect(needs('test aarch64-linux')).toEqual(builds);
    // a skipped matrix job keeps its name unrendered
    expect(needs('darwin ${{ matrix.target }}')).toEqual(builds);
    expect(needs('release ${{ matrix.target }}')).toEqual([]);
    expect(needs('qemu riscv32')).toEqual(builds);
    const gate = needs('gate')!;
    expect(gate).toHaveLength(jobs.length - 1);
    expect(gate).toContain(ids('docs')[0]);
    expect(new Set(gate)).toEqual(new Set(jobs.filter((j) => j.name !== 'gate').map((j) => j.id)));
    expect(calls.some((c) => c.includes(`contents/.github/workflows/ci.yml?ref=${sha}`))).toBe(true);
  });

  it('leaves needs unset when the workflow file cannot be read', async () => {
    const forge = github({
      'repos/o/r/actions/runs/3/jobs': { body: [{ id: 7, run_id: 3, head_sha: 'abc', name: 'gate', status: 'completed', conclusion: 'failure', html_url: 'u' }] },
      'repos/o/r/actions/runs/3': { body: { id: 3, head_sha: 'abc', path: '.github/workflows/gone.yml' } },
    });
    expect((await forge.jobs('o/r', '3'))[0]!.needs).toBeUndefined();
  });

  it('reads every page of comments with the commenter\'s standing and time, and the newest when capped', async () => {
    const calls: string[] = [];
    const at = (i: number) => `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`;
    const page = (from: number, count: number) => Array.from({ length: count }, (_, k) => ({ user: { login: `u${from + k}`, type: 'User' }, body: `c${from + k}`, created_at: at(from + k), author_association: from + k === 0 ? 'OWNER' : 'NONE' }));
    const forge = github({ 'repos/o/r/issues/5/comments': (argv) => ({ body: /page=1$/.test(argv[argv.length - 1]!) ? page(0, 100) : page(100, 2) }) }, calls);
    const all = await forge.comments('o/r', 'issue', 5);
    expect(all).toHaveLength(102);
    expect(all[0]).toEqual({ author: { login: 'u0', bot: false }, body: 'c0', createdAt: at(0), association: 'OWNER' });
    expect(calls.filter((c) => c.includes('/comments'))).toHaveLength(2);
    expect((await forge.comments('o/r', 'issue', 5, 1)).map((c) => c.body)).toEqual(['c101']);
    expect(await forge.comments('o/r', 'issue', 5, 0)).toEqual([]);
    expect(forge.maintains('OWNER') && forge.maintains('MEMBER') && forge.maintains('COLLABORATOR')).toBe(true);
    expect([forge.maintains('CONTRIBUTOR'), forge.maintains('FIRST_TIME_CONTRIBUTOR'), forge.maintains('NONE'), forge.maintains(undefined)]).toEqual([false, false, false, false]);
  });
});
