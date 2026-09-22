// everything sift asks a code host. one member today (github over gh); the shapes are held to what
// a second member (gitlab: merge requests, pipelines, project paths with slashes) can also answer.
// a repo is the forge's own path for it, opaque above this layer

export type ForgeUser = { login: string; bot: boolean };

export type Issue = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: ForgeUser;
  // the author's standing in the repository in the forge's own words (owner, member, contributor), when it says
  association?: string;
  labels: string[];
  milestone?: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export type PullRequest = Issue & {
  // the branch the change merges into
  base: string;
  head: { branch: string; sha: string };
  draft: boolean;
  merged: boolean;
  stats: { additions: number; deletions: number; files: number };
};

export type IssueSummary = { number: number; title: string };

export type Comment = {
  author: ForgeUser;
  body: string;
  createdAt: string;
  // the commenter's standing in the repository in the forge's own words, as Issue.association
  association?: string;
};

export type Review = { author: ForgeUser; state: string; body: string };

export type ReviewComment = { author: ForgeUser; path: string; body: string };

// one check on a commit, whatever the forge calls it: a check run, a commit status, a pipeline job
export type Check = {
  name: string;
  // the forge's handle for the check's log when it keeps one (a job id); a plain status has none
  id?: string;
  done: boolean;
  // the forge's own word for the outcome, null until done
  conclusion: string | null;
  // a passing outcome; skipped and neutral outcomes pass
  ok: boolean;
};

// a ci run the forge reports on its own: a workflow run, a pipeline
export type Run = Check & {
  id: string;
  branch: string;
  sha: string;
  // what started it (push, pull_request, schedule) in the forge's words
  event: string;
  actor: string;
  url: string;
  updatedAt: string;
};

// one job of a ci run: what jobLog reads by id
export type Job = Check & { id: string; run: string; sha: string; url: string };

// one step of a job's log as the forge marks it; a forge that marks no steps hands the whole log as one step
export type LogStep = { name: string; ok: boolean; text: string };

// a job's log with the commit it ran on, so the pull request under test is found without another read
export type JobLog = { job: string; run: string; sha: string; url: string; steps: LogStep[] };

export type Commit = { sha: string; message: string; merge: boolean };

// the head of an open pull request and who opened it
export type PullHead = { number: number; title: string; branch: string; sha: string; url: string; user: string };

// an issue or pull request as the watch sees it: enough to notice a change without holding the body
export type WatchItem = {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  state: string;
  author: ForgeUser;
  body: { length: number; head: string };
  comments: number;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  merged: boolean;
  url: string;
};

// what a call costs: calls left in the window and when it refills (epoch seconds), when the forge reports them
export type Rate = { remaining?: number; reset?: number };

// a conditional read: unchanged answers without a body; changed carries the value and the token that
// makes the next read conditional (an etag, a sequence number, whatever the forge keys on)
export type Conditional<T> = { rate: Rate } & ({ changed: false } | { changed: true; token?: string; value: T });

export type Template = { kind: 'issue' | 'pr'; name: string; body: string };

// the artifact a body belongs to and what a write does to it
export type ForgeArtifact = 'issue' | 'pr' | 'release';
export type ForgeAction = 'create' | 'comment' | 'edit' | 'review' | 'merge';

// a write the forge's cli makes: a regex over the command, the flags carrying the body inline, the flags naming a file it is read from
export type ForgeWrite = { kind: ForgeArtifact; action: ForgeAction; command: string; body: string[]; file: string[] };

// an issue or pull request a url on the forge names, with the repo as the forge paths it
export type ForgeLink = { repo: string; kind: 'issue' | 'pr'; number: number };

export interface Forge {
  // the forge's name as prose names it
  readonly name: string;
  // how the forge names each artifact in prose, for the judge: "GitHub issue", "merge request"
  readonly nouns: Record<ForgeArtifact, string>;
  // every artifact write the forge's cli makes from a shell command
  readonly writes: ForgeWrite[];

  // the repository the working directory is a checkout of, when it has a remote on this forge
  checkout(): Promise<{ repo: string; defaultBranch: string } | undefined>;
  login(): Promise<string | undefined>;
  defaultBranch(repo: string): Promise<string>;

  issue(repo: string, number: number): Promise<Issue>;
  // open issues, pull requests excluded
  openIssues(repo: string): Promise<IssueSummary[]>;
  // the parent of an issue in the forge's own hierarchy (sub-issues, epics), undefined without one
  parent(repo: string, number: number): Promise<number | undefined>;
  // every comment on an issue or pull request, oldest first; last keeps only the newest that many
  comments(repo: string, kind: 'issue' | 'pr', number: number, last?: number): Promise<Comment[]>;
  // whether a standing in the forge's own words (an association) is one that maintains the repository
  maintains(association: string | undefined): boolean;

  pull(repo: string, number: number): Promise<PullRequest>;
  diff(repo: string, number: number): Promise<string>;
  // the commits a pull request carries, oldest first, as the pull request lists them
  pullCommits(repo: string, number: number): Promise<Commit[]>;
  // issues the forge itself relates to the pull request as closed by it
  closingIssues(repo: string, number: number): Promise<number[]>;
  // the newest reviews and inline review comments on a pull request, oldest first; last caps how many
  reviews(repo: string, number: number, last?: number): Promise<Review[]>;
  reviewComments(repo: string, number: number, last?: number): Promise<ReviewComment[]>;
  // every check on a commit, check runs and statuses alike
  checks(repo: string, sha: string): Promise<Check[]>;

  // the kind of template a path is, from the locations the forge documents; undefined anywhere else
  template(path: string): Template['kind'] | undefined;
  // issue and pull request templates from every location the forge documents
  templates(repo: string): Promise<Template[]>;
  tags(repo: string): Promise<string[]>;
  // commits reachable from head and not from base, newest first
  compare(repo: string, base: string, head: string): Promise<Commit[]>;
  // the unified diff from the merge base of base and head to head: compareDiff(head, base) is what base
  // changed since the two parted
  compareDiff(repo: string, base: string, head: string): Promise<string>;
  // every commit reachable from ref, newest first
  commits(repo: string, ref: string): Promise<Commit[]>;
  // a file at a ref (the default branch when unset), undefined when absent
  file(repo: string, path: string, ref?: string): Promise<string | undefined>;
  // every file path at a ref (the default branch when unset), as a checkout's git ls-files would list them
  contents(repo: string, ref?: string): Promise<string[]>;

  // issues and pull requests updated since a stamp (iso 8601), unchanged when nothing moved since the token
  items(repo: string, since: string, token?: string): Promise<Conditional<WatchItem[]>>;
  // the newest ci runs; a repository without ci is unchanged forever
  runs(repo: string, token?: string): Promise<Conditional<Run[]>>;
  // the newest ci runs on one branch, empty for a repository without ci
  branchRuns(repo: string, branch: string): Promise<Run[]>;
  // the open pull request heads; without a token the read always answers changed
  pulls(repo: string, token?: string): Promise<Conditional<PullHead[]>>;
  // the jobs of a ci run
  jobs(repo: string, run: string): Promise<Job[]>;
  // a job's log split at the forge's own step marks
  jobLog(repo: string, job: string): Promise<JobLog>;

  // the issue or pull request a url in the forge's own shape names, undefined for any other text
  parseUrl(url: string): ForgeLink | undefined;
}
