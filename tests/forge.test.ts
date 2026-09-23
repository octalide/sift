import { describe, expect, it } from 'vitest';
import { GitHubForge, templateKind } from '../src/forge/github.ts';

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
  it('merges check runs and commit statuses into one list of checks, each actions check with its run', async () => {
    const job = (run: number, id: number) => `https://github.com/o/r/actions/runs/${run}/job/${id}`;
    const forge = github({
      'repos/o/r/commits/abc/check-runs': {
        body: {
          check_runs: [
            { id: 1, name: 'build', status: 'completed', conclusion: 'success', details_url: job(10, 1) },
            { id: 2, name: 'test', status: 'in_progress', conclusion: null, details_url: 'https://ci.example/build/2' },
            { id: 3, name: 'lint', status: 'completed', conclusion: 'timed_out', details_url: job(11, 3) },
            { id: 4, name: 'app', status: 'completed', conclusion: 'failure', details_url: null },
          ],
        },
      },
      'repos/o/r/commits/abc/status': { body: { statuses: [{ context: 'ext', state: 'pending' }, { context: 'cov', state: 'error' }] } },
    });
    expect(await forge.checks('o/r', 'abc')).toEqual([
      { name: 'build', run: '10', done: true, conclusion: 'success', ok: true },
      { name: 'test', done: false, conclusion: null, ok: false },
      { name: 'lint', run: '11', done: true, conclusion: 'timed_out', ok: false },
      { name: 'app', done: true, conclusion: 'failure', ok: false },
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

  it('tells a pull request from an issue read by number, since the issues endpoint serves both', async () => {
    const raw = (n: number, pr: boolean) => ({ number: n, title: 't', body: null, state: 'open', user: { login: 'a' }, labels: [], milestone: null, html_url: 'u', created_at: '1', updated_at: '2', ...(pr ? { pull_request: { url: 'p' } } : {}) });
    const forge = github({
      'repos/o/r/issues/1': { body: raw(1, false) },
      'repos/o/r/issues/2': { body: raw(2, true) },
      'repos/o/r/pulls/2': { body: { ...raw(2, false), base: { ref: 'dev' }, head: { ref: 'fix/1', sha: 's' }, draft: false, merged: false, additions: 0, deletions: 0, changed_files: 0 } },
    });
    expect((await forge.issue('o/r', 1)).pr).toBe(false);
    expect((await forge.issue('o/r', 2)).pr).toBe(true);
    expect((await forge.pull('o/r', 2)).pr).toBe(true);
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

  it('lists every file at a ref with its blob id from the recursive tree, the default branch when none is named', async () => {
    const calls: string[] = [];
    const forge = github(
      {
        'repos/o/r/git/trees/': { body: { tree: [{ path: 'README.md', type: 'blob', sha: 'b1' }, { path: 'docs', type: 'tree', sha: 't1' }, { path: 'docs/a.md', type: 'blob', sha: 'b2' }] } },
        'repos/o/r': { body: { default_branch: 'main' } },
      },
      calls,
    );
    expect(await forge.contents('o/r')).toEqual([{ path: 'README.md', id: 'b1' }, { path: 'docs/a.md', id: 'b2' }]);
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

  it('lists the writes post makes', () => {
    expect(github({}).writes.map((w) => `${w.kind} ${w.action}`)).toEqual(['pr create', 'pr comment', 'pr edit', 'pr review', 'pr merge', 'issue create', 'issue comment', 'issue edit', 'release create', 'release edit']);
  });

  it('names the text write a gh command makes through the cli, and nothing else', () => {
    const { writeOf } = github({});
    const w = (line: string) => writeOf(line.split(' '));
    expect(w('gh pr create --fill')).toEqual({ kind: 'pr', action: 'create' });
    expect(w('gh issue new -t t')).toEqual({ kind: 'issue', action: 'create' });
    expect(w('gh issue comment 3 --edit-last')).toEqual({ kind: 'issue', action: 'comment' });
    expect(w('gh pr comment 3 -bx')).toEqual({ kind: 'pr', action: 'comment' });
    expect(w('gh release create v1')).toEqual({ kind: 'release', action: 'create' });
    expect(w('/usr/bin/gh pr edit 3 --body=x')).toEqual({ kind: 'pr', action: 'edit' });
    expect(w('gh pr edit 3 -t new')).toEqual({ kind: 'pr', action: 'edit' });
    expect(w('gh pr review 3 --approve -F r.md')).toEqual({ kind: 'pr', action: 'review' });
    expect(w('gh pr merge 3 --merge --subject s')).toEqual({ kind: 'pr', action: 'merge' });
    expect(w('gh release edit v1 --notes-file n.md')).toEqual({ kind: 'release', action: 'edit' });
    // a write with no text, and every read, passes
    expect(w('gh pr merge 3 --merge --delete-branch')).toBeUndefined();
    expect(w('gh pr review 3 --approve')).toBeUndefined();
    expect(w('gh issue edit 3 --add-label bug -B x')).toBeUndefined();
    expect(w('gh release edit v1 --draft=false')).toBeUndefined();
    expect(w('gh pr view 3 --json body')).toBeUndefined();
    expect(w('gh pr reviews 3')).toBeUndefined();
    expect(w('gh issue close 3 -c done')).toBeUndefined();
    expect(w('git commit -m x')).toBeUndefined();
    expect(w('gh')).toBeUndefined();
  });

  it('names the text write a gh api call makes, by method and path or graphql mutation', () => {
    const { writeOf } = github({});
    expect(writeOf(['gh', 'api', 'repos/o/r/issues', '-f', 'title=t', '-f', 'body=b'])).toEqual({ kind: 'issue', action: 'create' });
    expect(writeOf(['gh', 'api', '/repos/{owner}/{repo}/issues/4/comments', '-F', 'body=@c.md'])).toEqual({ kind: 'issue', action: 'comment' });
    expect(writeOf(['gh', 'api', '-X', 'PATCH', 'repos/o/r/issues/comments/99', '--input', 'c.json'])).toEqual({ kind: 'issue', action: 'comment' });
    expect(writeOf(['gh', 'api', '--method=PATCH', 'repos/o/r/issues/4', '-f', 'body=x'])).toEqual({ kind: 'issue', action: 'edit' });
    expect(writeOf(['gh', 'api', 'repos/o/r/pulls', '--input', '-'])).toEqual({ kind: 'pr', action: 'create' });
    expect(writeOf(['gh', 'api', 'repos/o/r/pulls/4/reviews', '-f', 'event=COMMENT', '-f', 'body=x'])).toEqual({ kind: 'pr', action: 'review' });
    expect(writeOf(['gh', 'api', 'repos/o/r/pulls/4/comments/7/replies', '-f', 'body=x'])).toEqual({ kind: 'pr', action: 'comment' });
    expect(writeOf(['gh', 'api', '-XPUT', 'repos/o/r/pulls/4/merge', '-f', 'commit_title=t'])).toEqual({ kind: 'pr', action: 'merge' });
    expect(writeOf(['gh', 'api', 'repos/o/r/releases', '-f', 'tag_name=v1'])).toEqual({ kind: 'release', action: 'create' });
    expect(writeOf(['gh', 'api', '-X', 'PATCH', 'repos/o/r/releases/12', '-f', 'body=n'])).toEqual({ kind: 'release', action: 'edit' });
    expect(writeOf(['gh', 'api', 'graphql', '-f', 'query=mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }'])).toEqual({ kind: 'issue', action: 'comment' });
    expect(writeOf(['gh', 'api', 'graphql', '-f', 'query=mutation($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }'])).toEqual({ kind: 'pr', action: 'merge' });
    // reads, and writes that carry no text
    expect(writeOf(['gh', 'api', 'repos/o/r/issues'])).toBeUndefined();
    expect(writeOf(['gh', 'api', 'repos/o/r/issues/4/comments', '--jq', '.[].body'])).toBeUndefined();
    expect(writeOf(['gh', 'api', '-X', 'PATCH', 'repos/o/r/issues/4', '-f', 'state=closed'])).toBeUndefined();
    expect(writeOf(['gh', 'api', '-X', 'PUT', 'repos/o/r/pulls/4/merge', '-f', 'merge_method=merge'])).toBeUndefined();
    expect(writeOf(['gh', 'api', 'repos/o/r/issues/4/labels', '-f', 'labels[]=bug'])).toBeUndefined();
    expect(writeOf(['gh', 'api', 'graphql', '-f', 'query=query { viewer { login } }'])).toBeUndefined();
    expect(writeOf(['gh', 'api', 'graphql', '-f', 'query=mutation { addLabelsToLabelable(input: {}) { clientMutationId } }'])).toBeUndefined();
  });

  it('posts each write to the repo it names, the json on stdin, and answers the url', async () => {
    const calls: { argv: string; stdin?: unknown }[] = [];
    const forge = new GitHubForge(async (argv, init) => {
      const path = argv[argv.length - 1]!;
      calls.push({ argv: argv.join(' '), stdin: init?.stdin === undefined ? undefined : JSON.parse(init.stdin) });
      const body = path.endsWith('/merge') ? { merged: true } : path.includes('releases/tags/') ? { id: 12 } : /pulls\/\d+$/.test(path) ? { html_url: 'https://github.com/o/r/pull/4', number: 4, title: '', body: '', state: 'open', user: { login: 'a' }, labels: [], milestone: null, created_at: '', updated_at: '', base: { ref: 'dev' }, head: { ref: 'f', sha: 's' } } : { html_url: `https://github.com/${path}` };
      return { exitCode: 0, stdout: `HTTP/2.0 200 OK\r\nEtag: "e"\r\n\r\n${JSON.stringify(body)}`, stderr: '' };
    });
    expect(await forge.post('o/r', { kind: 'issue', action: 'create', title: 't', body: 'b' })).toBe('https://github.com/repos/o/r/issues');
    expect(calls.pop()).toEqual({ argv: 'gh api -i -X POST --input - repos/o/r/issues', stdin: { title: 't', body: 'b' } });
    await forge.post('o/r', { kind: 'pr', action: 'create', title: 't', body: 'b', base: 'dev', head: 'feat/1' });
    expect(calls.pop()).toEqual({ argv: 'gh api -i -X POST --input - repos/o/r/pulls', stdin: { title: 't', body: 'b', base: 'dev', head: 'feat/1', draft: false } });
    await forge.post('o/r', { kind: 'pr', action: 'comment', number: 4, body: 'c' });
    expect(calls.pop()).toEqual({ argv: 'gh api -i -X POST --input - repos/o/r/issues/4/comments', stdin: { body: 'c' } });
    await forge.post('o/r', { kind: 'issue', action: 'edit', number: 4, body: 'e' });
    expect(calls.pop()).toEqual({ argv: 'gh api -i -X PATCH --input - repos/o/r/issues/4', stdin: { body: 'e' } });
    await forge.post('o/r', { kind: 'pr', action: 'review', number: 4, verdict: 'request-changes', body: 'r' });
    expect(calls.pop()).toEqual({ argv: 'gh api -i -X POST --input - repos/o/r/pulls/4/reviews', stdin: { event: 'REQUEST_CHANGES', body: 'r' } });
    expect(await forge.post('o/r', { kind: 'pr', action: 'merge', number: 4, method: 'merge', body: 'm' })).toBe('https://github.com/o/r/pull/4');
    expect(calls.slice(-2).map((c) => c.argv)).toEqual(['gh api -i -X PUT --input - repos/o/r/pulls/4/merge', 'gh api -i repos/o/r/pulls/4']);
    expect(calls[calls.length - 2]!.stdin).toEqual({ merge_method: 'merge', commit_message: 'm' });
    await forge.post('o/r', { kind: 'release', action: 'create', tag: 'v1', body: 'n', target: 'main' });
    expect(calls.pop()).toEqual({ argv: 'gh api -i -X POST --input - repos/o/r/releases', stdin: { tag_name: 'v1', body: 'n', draft: false, prerelease: false, target_commitish: 'main' } });
    expect(await forge.post('o/r', { kind: 'release', action: 'edit', tag: 'v1', title: 'One' })).toBe('https://github.com/repos/o/r/releases/12');
    expect(calls.slice(-2)).toEqual([{ argv: 'gh api -i repos/o/r/releases/tags/v1', stdin: undefined }, { argv: 'gh api -i -X PATCH --input - repos/o/r/releases/12', stdin: { name: 'One' } }]);
  });

  it('names the command that reads a failed run\'s log, in the repository it names', () => {
    expect(github({}).logCommand('o/r', '35781279928')).toBe('gh run view 35781279928 --log-failed -R o/r');
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
