import { Gh, GhError, type ApiResponse } from './gh.ts';
import type { CwdLike, RunLike } from '../process.ts';
import type { Check, Comment, Commit, Conditional, Forge, ForgeAction, ForgeArtifact, ForgeLink, ForgeUser, ForgeWrite, Issue, IssueSummary, Job, JobLog, LogStep, PullHead, PullRequest, Rate, Review, ReviewComment, Run, Template, WatchItem } from './forge.ts';

type GhUser = { login: string; type?: string };
type GhIssue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: GhUser;
  labels: { name: string }[];
  milestone: { title: string } | null;
  html_url: string;
  pull_request?: unknown;
  author_association?: string;
  created_at: string;
  updated_at: string;
};
type GhPull = GhIssue & {
  base: { ref: string };
  head: { ref: string; sha: string };
  draft: boolean;
  merged: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
};
type GhComment = { user: GhUser; body: string; created_at: string };
type GhCommit = { sha: string; parents: { sha: string }[]; commit: { message: string } };
type GhCheckRun = { id: number; name: string; status: string; conclusion: string | null };
type GhJob = { id: number; run_id: number; head_sha: string; name: string; status: string; conclusion: string | null; html_url: string };
type GhStatus = { context: string; state: string };
type GhRun = {
  id: number;
  name: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  html_url: string;
  actor?: { login: string };
  updated_at: string;
};
type GhEntry = { name: string; path: string; type: string };

const RAW = 'application/vnd.github.raw+json';
const COMMIT_JQ = '[.[] | {sha, parents, commit: {message: .commit.message}}]';
const PASSING = new Set(['success', 'skipped', 'neutral']);

// the slim record the items poll produces server side, so a page of 100 stays small
export const ITEM_JQ = '[.[] | {n: .number, t: .title, s: .state, u: .user.login, ut: .user.type, bl: ((.body // "") | length), bp: ((.body // "")[0:400]), c: .comments, l: ([.labels[].name] | sort | join(",")), up: .updated_at, cr: .created_at, url: .html_url, pr: (.pull_request != null), m: (.pull_request.merged_at != null)}]';

export type RawItem = {
  n: number;
  t: string;
  s: string;
  u: string;
  ut?: string;
  bl: number;
  bp: string;
  c: number;
  l: string;
  up: string;
  cr: string;
  url: string;
  pr: boolean;
  m: boolean;
};

// the html and api urls of an issue or pull request; anything past the number (a comment anchor, /files) is ignored
const GH_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s#?]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/;
const GH_API_URL = /^https?:\/\/api\.github\.com\/repos\/([^/\s]+\/[^/\s#?]+)\/(issues|pulls)\/(\d+)(?:[/?#].*)?$/;

// gh pr and gh issue take --body and --body-file (pr review and pr merge too); gh release takes --notes and --notes-file, and has no comment
const ghWrite = (kind: ForgeArtifact, action: ForgeAction, noun: string): ForgeWrite => ({
  kind,
  action,
  command: String.raw`^\s*gh\s+${kind}\s+${action}\b`,
  body: [`--${noun}`, `-${noun[0]}`],
  file: [`--${noun}-file`, '-F'],
});
export const GH_WRITES: ForgeWrite[] = [
  ...(['create', 'comment', 'edit', 'review', 'merge'] as const).map((action) => ghWrite('pr', action, 'body')),
  ...(['create', 'comment', 'edit'] as const).map((action) => ghWrite('issue', action, 'body')),
  ...(['create', 'edit'] as const).map((action) => ghWrite('release', action, 'notes')),
];

const user = (u: GhUser): ForgeUser => ({ login: u.login, bot: u.type === 'Bot' || u.login.endsWith('[bot]') });

const commit = (c: GhCommit): Commit => ({ sha: c.sha, message: c.commit.message, merge: c.parents.length > 1 });

const issue = (i: GhIssue): Issue => ({
  number: i.number,
  title: i.title,
  body: i.body ?? '',
  state: i.state === 'open' ? 'open' : 'closed',
  author: user(i.user),
  association: i.author_association,
  labels: i.labels.map((l) => l.name),
  milestone: i.milestone?.title,
  url: i.html_url,
  createdAt: i.created_at,
  updatedAt: i.updated_at,
});

export function toWatchItem(raw: RawItem): WatchItem {
  return {
    kind: raw.pr ? 'pr' : 'issue',
    number: raw.n,
    title: raw.t,
    state: raw.s,
    author: user({ login: raw.u, type: raw.ut }),
    body: { length: raw.bl, head: raw.bp },
    comments: raw.c,
    labels: raw.l ? raw.l.split(',') : [],
    createdAt: raw.cr,
    updatedAt: raw.up,
    merged: raw.m,
    url: raw.url,
  };
}

// a check run's id is its job's id when actions ran it, so the log is reachable from the check
const checkRun = (c: GhCheckRun): Check => ({ name: c.name, id: String(c.id), done: c.status === 'completed', conclusion: c.conclusion, ok: PASSING.has(c.conclusion ?? '') });
const job = (j: GhJob): Job => ({ id: String(j.id), name: j.name, run: String(j.run_id), sha: j.head_sha, done: j.status === 'completed', conclusion: j.conclusion, ok: PASSING.has(j.conclusion ?? ''), url: j.html_url });
const status = (s: GhStatus): Check => ({ name: s.context, done: s.state !== 'pending', conclusion: s.state === 'pending' ? null : s.state, ok: s.state === 'success' });

const run = (r: GhRun): Run => ({
  id: String(r.id),
  name: r.name,
  done: r.status === 'completed',
  conclusion: r.conclusion,
  ok: PASSING.has(r.conclusion ?? ''),
  branch: r.head_branch,
  sha: r.head_sha,
  event: r.event,
  actor: r.actor?.login ?? '',
  url: r.html_url,
  updatedAt: r.updated_at,
});

const rate = (r: ApiResponse): Rate => ({ remaining: r.remaining, reset: r.reset });

const STEP_START = /^(?:\uFEFF)?(?:\S+Z )?##\[group\]Run (.*)$/;
const STEP_POST = /^(?:\S+Z )?Post job cleanup\.$/;
const STEP_ERROR = /^(?:\S+Z )?##\[error\]/;

// the runner opens each step with a "##[group]Run <name>" line, each post step with "Post job cleanup.", and marks
// a failed step with "##[error]"; the lines before the first step are the job setup, kept as a step of their own
export function splitJobLog(text: string): LogStep[] {
  const steps: { name: string; lines: string[] }[] = [{ name: 'Set up job', lines: [] }];
  for (const line of text.split('\n')) {
    const start = STEP_START.exec(line);
    if (start) steps.push({ name: `Run ${start[1]!}`, lines: [] });
    else if (STEP_POST.test(line)) steps.push({ name: 'Post job cleanup', lines: [] });
    steps[steps.length - 1]!.lines.push(line);
  }
  return steps.filter((s) => s.lines.some((l) => l.trim() !== '')).map((s) => ({ name: s.name, ok: !s.lines.some((l) => STEP_ERROR.test(l)), text: s.lines.join('\n') }));
}

const missing = (error: unknown): boolean => error instanceof GhError && /http 40[34]/.test(error.message);

// where github documents templates: a single file or a directory of them, in the root, docs/ or .github/
const TEMPLATE_DIRS = ['', 'docs', '.github'];
const TEMPLATE_FILE: Record<Template['kind'], RegExp> = { issue: /^issue_template\.(md|yml|yaml)$/i, pr: /^pull_request_template\.md$/i };
const TEMPLATE_DIR: Record<Template['kind'], RegExp> = { issue: /^issue_template$/i, pr: /^pull_request_template$/i };
const TEMPLATE_ENTRY: Record<Template['kind'], RegExp> = { issue: /\.(md|yml|yaml)$/i, pr: /\.md$/i };
// config.yml beside issue forms configures the chooser, it is no template
const TEMPLATE_CHOOSER = /^config\.ya?ml$/i;

// the kind of template at a path, from where github documents them; undefined anywhere else
export function templateKind(path: string): Template['kind'] | undefined {
  const parts = path.split('/');
  const name = parts.pop()!;
  const single = parts.length <= 1 && TEMPLATE_DIRS.includes(parts[0] ?? '');
  const sub = parts.pop();
  const nested = sub !== undefined && parts.length <= 1 && TEMPLATE_DIRS.includes(parts[0] ?? '');
  for (const kind of ['issue', 'pr'] as const) {
    if (single && TEMPLATE_FILE[kind].test(name)) return kind;
    if (nested && TEMPLATE_DIR[kind].test(sub) && TEMPLATE_ENTRY[kind].test(name) && !TEMPLATE_CHOOSER.test(name)) return kind;
  }
  return undefined;
}

export class GitHubForge implements Forge {
  readonly name = 'GitHub';
  readonly nouns: Record<ForgeArtifact, string> = { issue: 'GitHub issue', pr: 'pull request', release: 'GitHub release' };
  readonly writes = GH_WRITES;
  readonly gh: Gh;

  constructor(run: RunLike, cwd?: CwdLike) {
    this.gh = new Gh(run, cwd);
  }

  async checkout(): Promise<{ repo: string; defaultBranch: string } | undefined> {
    const info = await this.gh.repoInfo();
    return info ? { repo: info.nameWithOwner, defaultBranch: info.defaultBranch } : undefined;
  }

  login(): Promise<string | undefined> {
    return this.gh.login();
  }

  async defaultBranch(repo: string): Promise<string> {
    return (await this.gh.json<{ default_branch: string }>(`repos/${repo}`)).default_branch;
  }

  async issue(repo: string, number: number): Promise<Issue> {
    return issue(await this.gh.json<GhIssue>(`repos/${repo}/issues/${number}`));
  }

  async openIssues(repo: string): Promise<IssueSummary[]> {
    const all = await this.gh.json<GhIssue[]>(`repos/${repo}/issues?state=open&per_page=100`);
    return all.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title }));
  }

  async parent(repo: string, number: number): Promise<number | undefined> {
    try {
      const p = await this.gh.json<{ number: number } | null>(`repos/${repo}/issues/${number}/parent`);
      return p?.number;
    } catch {
      return undefined;
    }
  }

  // issue and pull request comments share one endpoint on github
  async comments(repo: string, _kind: 'issue' | 'pr', number: number, last?: number): Promise<Comment[]> {
    const page = last === undefined ? 'per_page=100' : `per_page=${last}&direction=desc&sort=created`;
    const got = await this.gh.json<GhComment[]>(`repos/${repo}/issues/${number}/comments?${page}`);
    return (last === undefined ? got : [...got].reverse()).map((c) => ({ author: user(c.user), body: c.body, createdAt: c.created_at }));
  }

  async pull(repo: string, number: number): Promise<PullRequest> {
    const pr = await this.gh.json<GhPull>(`repos/${repo}/pulls/${number}`);
    return {
      ...issue(pr),
      base: pr.base.ref,
      head: { branch: pr.head.ref, sha: pr.head.sha },
      draft: pr.draft,
      merged: pr.merged,
      stats: { additions: pr.additions, deletions: pr.deletions, files: pr.changed_files },
    };
  }

  diff(repo: string, number: number): Promise<string> {
    return this.gh.text(`repos/${repo}/pulls/${number}`, 'application/vnd.github.diff');
  }

  async pullCommits(repo: string, number: number): Promise<Commit[]> {
    return (await this.gh.json<GhCommit[]>(`repos/${repo}/pulls/${number}/commits?per_page=100`)).map(commit);
  }

  async closingIssues(repo: string, number: number): Promise<number[]> {
    const [owner, name] = repo.split('/');
    const query = `query { repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { closingIssuesReferences(first: 50) { nodes { number } } } } }`;
    const r = await this.gh.json<{ data?: { repository?: { pullRequest?: { closingIssuesReferences?: { nodes: { number: number }[] } } } } }>('graphql', { method: 'POST', fields: { query } });
    return (r.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? []).map((n) => n.number);
  }

  async reviews(repo: string, number: number, last?: number): Promise<Review[]> {
    const all = await this.gh.json<{ user: GhUser; state: string; body: string }[]>(`repos/${repo}/pulls/${number}/reviews?per_page=100`);
    return (last === undefined ? all : all.slice(-last)).map((r) => ({ author: user(r.user), state: r.state, body: r.body }));
  }

  async reviewComments(repo: string, number: number, last?: number): Promise<ReviewComment[]> {
    const page = last === undefined ? 'per_page=100' : `per_page=${last}&direction=desc&sort=created`;
    const got = await this.gh.json<{ user: GhUser; path: string; body: string }[]>(`repos/${repo}/pulls/${number}/comments?${page}`);
    return (last === undefined ? got : [...got].reverse()).map((c) => ({ author: user(c.user), path: c.path, body: c.body }));
  }

  async checks(repo: string, sha: string): Promise<Check[]> {
    const [runs, statuses] = await Promise.all([
      this.gh.json<{ check_runs: GhCheckRun[] }>(`repos/${repo}/commits/${sha}/check-runs?per_page=100`),
      this.gh.json<{ statuses: GhStatus[] }>(`repos/${repo}/commits/${sha}/status`),
    ]);
    return [...(runs.check_runs ?? []).map(checkRun), ...(statuses.statuses ?? []).map(status)];
  }

  template(path: string): Template['kind'] | undefined {
    return templateKind(path);
  }

  async templates(repo: string): Promise<Template[]> {
    const out: Template[] = [];
    const list = (dir: string) => this.gh.json<GhEntry[]>(`repos/${repo}/contents/${dir}`).catch((e: unknown) => (missing(e) ? [] : Promise.reject(e)));
    const read = async (kind: Template['kind'], entries: GhEntry[]) => {
      for (const e of entries.filter((e) => e.type === 'file' && templateKind(e.path) === kind)) {
        const body = await this.file(repo, e.path);
        if (body !== undefined) out.push({ kind, name: e.path, body });
      }
    };
    for (const dir of TEMPLATE_DIRS) {
      const entries = await list(dir);
      for (const kind of ['issue', 'pr'] as const) {
        await read(kind, entries);
        for (const d of entries.filter((e) => e.type === 'dir' && TEMPLATE_DIR[kind].test(e.name))) await read(kind, await list(d.path));
      }
    }
    return out;
  }

  async tags(repo: string): Promise<string[]> {
    return (await this.gh.pages<string>(`repos/${repo}/tags`, '[.[].name]')).flat();
  }

  // compare lists oldest first and caps at 250; the ranges asked here are far smaller
  async compare(repo: string, base: string, head: string): Promise<Commit[]> {
    const cmp = await this.gh.json<{ commits: GhCommit[] }>(`repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    return cmp.commits.map(commit).reverse();
  }

  compareDiff(repo: string, base: string, head: string): Promise<string> {
    return this.gh.text(`repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, 'application/vnd.github.diff');
  }

  async commits(repo: string, ref: string): Promise<Commit[]> {
    return (await this.gh.pages<GhCommit>(`repos/${repo}/commits?sha=${encodeURIComponent(ref)}`, COMMIT_JQ)).map(commit);
  }

  file(repo: string, path: string, ref?: string): Promise<string | undefined> {
    return this.gh.text(`repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, RAW).catch(() => undefined);
  }

  // the recursive git tree in one call; github truncates it past its own limit and says so
  async contents(repo: string, ref?: string): Promise<string[]> {
    const at = ref ?? (await this.defaultBranch(repo));
    const tree = await this.gh.json<{ tree?: { path: string; type: string }[] }>(`repos/${repo}/git/trees/${encodeURIComponent(at)}?recursive=1`);
    return (tree.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path);
  }

  // one conditional probe on the newest item, then the pages since the stamp only when it moved
  async items(repo: string, since: string, token?: string): Promise<Conditional<WatchItem[]>> {
    const probe = await this.gh.api(`repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=1`, { etag: token });
    if (probe.status === 304) return { changed: false, rate: rate(probe) };
    const raw = await this.gh.pages<RawItem>(`repos/${repo}/issues?state=all&sort=updated&direction=asc&since=${since}`, ITEM_JQ);
    return { changed: true, token: probe.etag, rate: rate(probe), value: raw.map(toWatchItem) };
  }

  async runs(repo: string, token?: string): Promise<Conditional<Run[]>> {
    let probe: ApiResponse;
    try {
      probe = await this.gh.api(`repos/${repo}/actions/runs?per_page=30`, { etag: token });
    } catch (error) {
      // a repo without actions answers 404 or 403
      if (missing(error)) return { changed: false, rate: {} };
      throw error;
    }
    if (probe.status === 304) return { changed: false, rate: rate(probe) };
    const parsed = JSON.parse(probe.body || '{}') as { workflow_runs?: GhRun[] };
    return { changed: true, token: probe.etag, rate: rate(probe), value: (parsed.workflow_runs ?? []).map(run) };
  }

  async branchRuns(repo: string, branch: string): Promise<Run[]> {
    try {
      const parsed = await this.gh.json<{ workflow_runs?: GhRun[] } | null>(`repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=30`);
      return (parsed?.workflow_runs ?? []).map(run);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }

  async pulls(repo: string, token?: string): Promise<Conditional<PullHead[]>> {
    const probe = await this.gh.api(`repos/${repo}/pulls?state=open&per_page=100`, { etag: token });
    if (probe.status === 304) return { changed: false, rate: rate(probe) };
    const raw = JSON.parse(probe.body || '[]') as { number: number; title: string; head: { ref: string; sha: string }; html_url: string; user: GhUser }[];
    return { changed: true, token: probe.etag, rate: rate(probe), value: raw.map((p) => ({ number: p.number, title: p.title, branch: p.head.ref, sha: p.head.sha, url: p.html_url, user: p.user.login })) };
  }

  async jobs(repo: string, run: string): Promise<Job[]> {
    return (await this.gh.pages<GhJob>(`repos/${repo}/actions/runs/${encodeURIComponent(run)}/jobs`, '[.jobs[] | {id, run_id, head_sha, name, status, conclusion, html_url}]')).map(job);
  }

  // the logs endpoint refuses any accept but json and answers a 302 to the log's download url, which gh follows
  // under its default accept, so the response read here is the download itself
  async jobLog(repo: string, id: string): Promise<JobLog> {
    const [j, log] = await Promise.all([
      this.gh.json<GhJob>(`repos/${repo}/actions/jobs/${encodeURIComponent(id)}`),
      this.gh.api(`repos/${repo}/actions/jobs/${encodeURIComponent(id)}/logs`, { raw: true }),
    ]);
    return { job: j.name, run: String(j.run_id), sha: j.head_sha, url: j.html_url, steps: splitJobLog(log.body) };
  }

  parseUrl(url: string): ForgeLink | undefined {
    const m = GH_URL.exec(url.trim()) ?? GH_API_URL.exec(url.trim());
    if (!m) return undefined;
    return { repo: m[1]!, kind: m[2] === 'issues' ? 'issue' : 'pr', number: Number(m[3]) };
  }
}
