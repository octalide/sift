import { Gh, GhError, type ApiResponse } from './gh.ts';
import type { CwdLike, RunLike } from '../process.ts';
import type { Check, Comment, Commit, Conditional, Forge, ForgeAction, ForgeArtifact, ForgeLink, ForgePost, ForgeUser, ForgeWrite, Issue, IssueSummary, PullHead, PullRequest, Rate, Review, ReviewComment, ReviewVerdict, Run, Template, WatchItem } from './forge.ts';

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
type GhComment = { user: GhUser; body: string | null; created_at: string; author_association?: string };
type GhCommit = { sha: string; parents: { sha: string }[]; commit: { message: string } };
type GhCheckRun = { name: string; status: string; conclusion: string | null; details_url?: string | null };
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
  // the workflow file the run ran
  path?: string;
  actor?: { login: string };
  updated_at: string;
};
type GhEntry = { name: string; path: string; type: string };

const RAW = 'application/vnd.github.raw+json';
const COMMIT_JQ = '[.[] | {sha, parents, commit: {message: .commit.message}}]';
const PASSING = new Set(['success', 'skipped', 'neutral']);
// the associations that maintain a repository; contributor, first-timer and none do not
const MAINTAINING = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const COMMENT_JQ = '[.[] | {user: {login: .user.login, type: .user.type}, body, created_at, author_association}]';

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

export const GH_WRITES: ForgeWrite[] = [
  ...(['create', 'comment', 'edit', 'review', 'merge'] as const).map((action) => ({ kind: 'pr' as const, action })),
  ...(['create', 'comment', 'edit'] as const).map((action) => ({ kind: 'issue' as const, action })),
  ...(['create', 'edit'] as const).map((action) => ({ kind: 'release' as const, action })),
];

// the flags of each gh write that carry text, and the other names gh takes for a subcommand
const CLI_TEXT: Record<ForgeArtifact, string[]> = {
  pr: ['--body', '-b', '--body-file', '-F', '--title', '-t', '--subject'],
  issue: ['--body', '-b', '--body-file', '-F', '--title', '-t'],
  release: ['--notes', '-n', '--notes-file', '-F', '--title', '-t'],
};
const CLI_ALIASES: Record<string, ForgeAction> = { new: 'create' };

// a create or a comment always sends text; an edit, a review or a merge only when a text flag is given
const alwaysText = (action: ForgeAction): boolean => action === 'create' || action === 'comment';

// the rest endpoints that write text, by method and path; a path is matched without its leading slash or query
const API_WRITES: { method: string; path: RegExp; write: ForgeWrite }[] = [
  { method: 'POST', path: /^repos\/[^/]+\/[^/]+\/issues$/, write: { kind: 'issue', action: 'create' } },
  { method: 'POST', path: /^repos\/[^/]+\/[^/]+\/issues\/[^/]+\/comments$/, write: { kind: 'issue', action: 'comment' } },
  { method: 'PATCH', path: /^repos\/[^/]+\/[^/]+\/issues\/comments\/[^/]+$/, write: { kind: 'issue', action: 'comment' } },
  { method: 'PATCH', path: /^repos\/[^/]+\/[^/]+\/issues\/[^/]+$/, write: { kind: 'issue', action: 'edit' } },
  { method: 'POST', path: /^repos\/[^/]+\/[^/]+\/pulls$/, write: { kind: 'pr', action: 'create' } },
  { method: 'PATCH', path: /^repos\/[^/]+\/[^/]+\/pulls\/comments\/[^/]+$/, write: { kind: 'pr', action: 'comment' } },
  { method: 'PATCH', path: /^repos\/[^/]+\/[^/]+\/pulls\/[^/]+$/, write: { kind: 'pr', action: 'edit' } },
  { method: 'POST', path: /^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/comments(?:\/[^/]+\/replies)?$/, write: { kind: 'pr', action: 'comment' } },
  { method: 'POST', path: /^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews(?:\/[^/]+\/events)?$/, write: { kind: 'pr', action: 'review' } },
  { method: 'PUT', path: /^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews\/[^/]+$/, write: { kind: 'pr', action: 'review' } },
  { method: 'PUT', path: /^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/, write: { kind: 'pr', action: 'merge' } },
  { method: 'POST', path: /^repos\/[^/]+\/[^/]+\/releases$/, write: { kind: 'release', action: 'create' } },
  { method: 'PATCH', path: /^repos\/[^/]+\/[^/]+\/releases\/[^/]+$/, write: { kind: 'release', action: 'edit' } },
];
// the request fields that carry text on those endpoints
const API_TEXT_FIELDS = new Set(['body', 'title', 'name', 'commit_title', 'commit_message']);
// the graphql mutations that write text, by name
const GRAPHQL_WRITES: Record<string, ForgeWrite> = {
  createIssue: { kind: 'issue', action: 'create' },
  updateIssue: { kind: 'issue', action: 'edit' },
  addComment: { kind: 'issue', action: 'comment' },
  updateIssueComment: { kind: 'issue', action: 'comment' },
  createPullRequest: { kind: 'pr', action: 'create' },
  updatePullRequest: { kind: 'pr', action: 'edit' },
  addPullRequestReview: { kind: 'pr', action: 'review' },
  submitPullRequestReview: { kind: 'pr', action: 'review' },
  updatePullRequestReview: { kind: 'pr', action: 'review' },
  addPullRequestReviewComment: { kind: 'pr', action: 'comment' },
  addPullRequestReviewThread: { kind: 'pr', action: 'comment' },
  addPullRequestReviewThreadReply: { kind: 'pr', action: 'comment' },
  updatePullRequestReviewComment: { kind: 'pr', action: 'comment' },
  mergePullRequest: { kind: 'pr', action: 'merge' },
  enablePullRequestAutoMerge: { kind: 'pr', action: 'merge' },
};
// gh api flags that take a value, so the path is the first word that is neither a flag nor a flag's value
const API_VALUE_FLAGS = new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);

// a flag given as its own word, as flag=value, or as a shorthand with its value glued on
const hasFlag = (words: string[], flags: string[]): boolean =>
  words.some((w) => flags.some((f) => w === f || w.startsWith(`${f}=`) || (/^-[A-Za-z]$/.test(f) && w.startsWith(f) && w.length > 2)));

// the write a gh command makes, when it sends text
export function ghWriteOf(words: string[]): ForgeWrite | undefined {
  if (words.length < 2 || !/(?:^|\/)gh$/.test(words[0]!)) return undefined;
  const [, group, sub] = words;
  if (group === 'api') return ghApiWriteOf(words.slice(2));
  if (group !== 'pr' && group !== 'issue' && group !== 'release') return undefined;
  const action = CLI_ALIASES[sub ?? ''] ?? (sub as ForgeAction);
  if (!GH_WRITES.some((w) => w.kind === group && w.action === action)) return undefined;
  if (alwaysText(action) || hasFlag(words.slice(3), CLI_TEXT[group])) return { kind: group, action };
  return undefined;
}

function ghApiWriteOf(args: string[]): ForgeWrite | undefined {
  let method: string | undefined;
  let path: string | undefined;
  let input = false;
  const fields: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const eq = /^(--?[A-Za-z-]+)=(.*)$/s.exec(w);
    const [flag, glued] = eq ? [eq[1]!, eq[2]!] : /^-[A-Za-z]./.test(w) && !w.startsWith('--') ? [w.slice(0, 2), w.slice(2)] : [w, undefined];
    if (!API_VALUE_FLAGS.has(flag)) {
      if (!w.startsWith('-') && path === undefined) path = w;
      continue;
    }
    const value = glued ?? args[++i] ?? '';
    if (flag === '-X' || flag === '--method') method = value.toUpperCase();
    else if (flag === '--input') input = true;
    else if (flag === '-f' || flag === '--raw-field' || flag === '-F' || flag === '--field') fields.push(value);
  }
  if (path === undefined) return undefined;
  const at = path.replace(/^\//, '').replace(/\?.*$/s, '');
  if (at === 'graphql') {
    const mutation = fields.find((f) => /\bmutation\b/.test(f));
    if (mutation === undefined) return undefined;
    const named = Object.keys(GRAPHQL_WRITES).find((name) => new RegExp(`\\b${name}\\s*\\(`).test(mutation));
    return named === undefined ? undefined : GRAPHQL_WRITES[named];
  }
  const verb = method ?? (fields.length > 0 || input ? 'POST' : 'GET');
  const hit = API_WRITES.find((e) => e.method === verb && e.path.test(at));
  if (!hit) return undefined;
  const text = input || fields.some((f) => API_TEXT_FIELDS.has(f.split(/[=\[]/, 1)[0]!));
  return alwaysText(hit.write.action) || text ? hit.write : undefined;
}

const VERDICTS: Record<ReviewVerdict, string> = { approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' };

// a request field set only when given, so an edit leaves what it does not name
const given = <T extends Record<string, unknown>>(fields: T): Partial<T> => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;

const user = (u: GhUser): ForgeUser => ({ login: u.login, bot: u.type === 'Bot' || u.login.endsWith('[bot]') });

const comment = (c: GhComment): Comment => ({ author: user(c.user), body: c.body ?? '', createdAt: c.created_at, association: c.author_association });

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
  pr: i.pull_request != null,
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
// an actions check run links its job as .../actions/runs/<run>/job/<job>; a check from any other app names no run
const ACTIONS_JOB = /\/actions\/runs\/(\d+)\/job\/\d+/;

const checkRun = (c: GhCheckRun): Check => {
  const run = ACTIONS_JOB.exec(c.details_url ?? '')?.[1];
  return { name: c.name, done: c.status === 'completed', conclusion: c.conclusion, ok: PASSING.has(c.conclusion ?? ''), ...(run === undefined ? {} : { run }) };
};
const status = (s: GhStatus): Check => ({ name: s.context, done: s.state !== 'pending', conclusion: s.state === 'pending' ? null : s.state, ok: s.state === 'success' });

const run = (r: GhRun, tag: boolean): Run => ({
  id: String(r.id),
  name: r.name,
  done: r.status === 'completed',
  conclusion: r.conclusion,
  ok: PASSING.has(r.conclusion ?? ''),
  branch: r.head_branch,
  sha: r.head_sha,
  tag,
  event: r.event,
  actor: r.actor?.login ?? '',
  url: r.html_url,
  updatedAt: r.updated_at,
});

const rate = (r: ApiResponse): Rate => ({ remaining: r.remaining, reset: r.reset });

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
  // repo and ref name -> whether a tag of that name exists, read once per name
  private readonly tagRefs = new Map<string, Promise<boolean>>();

  constructor(run: RunLike, cwd?: CwdLike) {
    this.gh = new Gh(run, cwd);
  }

  // a workflow run names its ref without saying whether it is a branch or a tag, so a ref a pull request did not
  // start is looked up among the tags, once per name
  private isTag(repo: string, r: GhRun): Promise<boolean> {
    if (!r.head_branch || r.event.startsWith('pull_request')) return Promise.resolve(false);
    const key = `${repo}\0${r.head_branch}`;
    let known = this.tagRefs.get(key);
    if (!known) {
      const path = r.head_branch.split('/').map(encodeURIComponent).join('/');
      known = this.gh
        .json<{ ref: string }[] | null>(`repos/${repo}/git/matching-refs/tags/${path}`)
        .then((refs) => (refs ?? []).some((x) => x.ref === `refs/tags/${r.head_branch}`))
        .catch((error: unknown) => {
          this.tagRefs.delete(key);
          if (missing(error)) return false;
          throw error;
        });
      this.tagRefs.set(key, known);
    }
    return known;
  }

  private toRuns(repo: string, raw: GhRun[]): Promise<Run[]> {
    return Promise.all(raw.map(async (r) => run(r, await this.isTag(repo, r))));
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

  // issue and pull request comments share one endpoint on github. it lists oldest first and takes no sort
  // or direction, so the newest are the tail of every page
  async comments(repo: string, _kind: 'issue' | 'pr', number: number, last?: number): Promise<Comment[]> {
    const all = await this.gh.pages<GhComment>(`repos/${repo}/issues/${number}/comments`, COMMENT_JQ);
    return (last === undefined ? all : all.slice(Math.max(0, all.length - last))).map(comment);
  }

  maintains(association: string | undefined): boolean {
    return association !== undefined && MAINTAINING.has(association);
  }

  async pull(repo: string, number: number): Promise<PullRequest> {
    const pr = await this.gh.json<GhPull>(`repos/${repo}/pulls/${number}`);
    return {
      ...issue(pr),
      pr: true,
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
    return { changed: true, token: probe.etag, rate: rate(probe), value: await this.toRuns(repo, parsed.workflow_runs ?? []) };
  }

  async branchRuns(repo: string, branch: string): Promise<Run[]> {
    try {
      const parsed = await this.gh.json<{ workflow_runs?: GhRun[] } | null>(`repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=30`);
      return await this.toRuns(repo, parsed?.workflow_runs ?? []);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }

  async run(repo: string, id: string): Promise<Run> {
    const r = await this.gh.json<GhRun>(`repos/${repo}/actions/runs/${encodeURIComponent(id)}`);
    return run(r, await this.isTag(repo, r));
  }

  async pulls(repo: string, token?: string): Promise<Conditional<PullHead[]>> {
    const probe = await this.gh.api(`repos/${repo}/pulls?state=open&per_page=100`, { etag: token });
    if (probe.status === 304) return { changed: false, rate: rate(probe) };
    const raw = JSON.parse(probe.body || '[]') as { number: number; title: string; head: { ref: string; sha: string }; html_url: string; user: GhUser }[];
    return { changed: true, token: probe.etag, rate: rate(probe), value: raw.map((p) => ({ number: p.number, title: p.title, branch: p.head.ref, sha: p.head.sha, url: p.html_url, user: p.user.login })) };
  }

  logCommand(repo: string, run: string): string {
    return `gh run view ${run} --log-failed -R ${repo}`;
  }

  parseUrl(url: string): ForgeLink | undefined {
    const m = GH_URL.exec(url.trim()) ?? GH_API_URL.exec(url.trim());
    if (!m) return undefined;
    return { repo: m[1]!, kind: m[2] === 'issues' ? 'issue' : 'pr', number: Number(m[3]) };
  }

  // every write names its repository in the api path, so neither the working directory nor a fork's upstream decides it
  async post(repo: string, post: ForgePost): Promise<string> {
    const url = async (path: string, method: string, input: Record<string, unknown>) => (await this.gh.json<{ html_url: string }>(`repos/${repo}/${path}`, { method, input })).html_url;
    switch (post.action) {
      case 'create':
        if (post.kind === 'issue') return url('issues', 'POST', { title: post.title, body: post.body });
        if (post.kind === 'pr') return url('pulls', 'POST', { title: post.title, body: post.body, base: post.base, head: post.head, draft: post.draft ?? false });
        return url('releases', 'POST', { tag_name: post.tag, body: post.body, draft: post.draft ?? false, prerelease: post.prerelease ?? false, ...given({ target_commitish: post.target, name: post.title }) });
      case 'comment':
        return url(`issues/${post.number}/comments`, 'POST', { body: post.body });
      case 'edit': {
        if (post.kind !== 'release') return url(`${post.kind === 'issue' ? 'issues' : 'pulls'}/${post.number}`, 'PATCH', given({ title: post.title, body: post.body }));
        const release = await this.gh.json<{ id: number }>(`repos/${repo}/releases/tags/${encodeURIComponent(post.tag)}`);
        return url(`releases/${release.id}`, 'PATCH', given({ name: post.title, body: post.body }));
      }
      case 'review':
        return url(`pulls/${post.number}/reviews`, 'POST', { event: VERDICTS[post.verdict], ...given({ body: post.body }) });
      case 'merge':
        await this.gh.json(`repos/${repo}/pulls/${post.number}/merge`, { method: 'PUT', input: { merge_method: post.method, ...given({ commit_title: post.title, commit_message: post.body }) } });
        return (await this.pull(repo, post.number)).url;
    }
  }

  writeOf(words: string[]): ForgeWrite | undefined {
    return ghWriteOf(words);
  }
}
