import type { Forge, Issue, PullRequest } from '../src/forge/forge.ts';

// a forge that answers from what a test hands it and nothing else; every unhandled read answers empty
export function fakeForge(over: Partial<Forge> = {}): Forge {
  const issue = (number: number): Issue => ({ number, title: `Issue ${number}`, body: '', state: 'open', author: { login: 'alice', bot: false }, labels: [], url: `https://x/${number}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', pr: false });
  const pull = (number: number): PullRequest => ({ ...issue(number), pr: true, base: 'dev', head: { branch: `feat/${number}`, sha: 'abc1234def' }, draft: false, merged: false, stats: { additions: 1, deletions: 0, files: 1 } });
  return {
    name: 'Fake',
    nouns: { issue: 'Fake issue', pr: 'pull request', release: 'Fake release' },
    writes: [],
    checkout: async () => undefined,
    login: async () => undefined,
    defaultBranch: async () => 'main',
    issue: async (_r, n) => issue(n),
    openIssues: async () => [],
    parent: async () => undefined,
    comments: async () => [],
    maintains: (a) => a === 'OWNER' || a === 'MEMBER' || a === 'COLLABORATOR',
    pull: async (_r, n) => pull(n),
    diff: async () => '',
    pullCommits: async () => [],
    closingIssues: async () => [],
    reviews: async () => [],
    reviewComments: async () => [],
    checks: async () => [],
    template: () => undefined,
    templates: async () => [],
    tags: async () => [],
    compare: async () => [],
    compareDiff: async () => '',
    commits: async () => [],
    file: async () => undefined,
    contents: async () => [],
    items: async () => ({ changed: false, rate: {} }),
    runs: async () => ({ changed: false, rate: {} }),
    branchRuns: async () => [],
    run: async (_r, id) => ({ id, name: 'ci', branch: 'main', sha: 'abc1234def', tag: false, event: 'push', done: false, conclusion: null, ok: false, actor: 'alice', url: `https://x/runs/${id}`, updatedAt: '1' }),
    pulls: async () => ({ changed: true, rate: {}, value: [] }),
    parseUrl: (url) => {
      const m = /^https:\/\/fake\/([^/]+\/[^/]+)\/(issue|pr)\/(\d+)$/.exec(url);
      return m ? { repo: m[1]!, kind: m[2] as 'issue' | 'pr', number: Number(m[3]) } : undefined;
    },
    jobs: async () => [],
    jobLog: async (_r, id) => ({ job: `job ${id}`, run: '', sha: '', url: '', steps: [] }),
    ...over,
  };
}
