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
  // the number names a pull request; a forge that reads both through one endpoint says which it found
  pr: boolean;
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

// how a check or a run ended, whatever the forge calls it
export type Outcome = {
  name: string;
  done: boolean;
  // the forge's own word for the outcome, null until done
  conclusion: string | null;
  // a passing outcome; skipped and neutral outcomes pass
  ok: boolean;
};

// one check on a commit: a check run, a commit status, a pipeline job
export type Check = Outcome & {
  // the ci run the check belongs to when the forge keeps its log (a workflow run id); a plain status has none
  run?: string;
};

// a ci run the forge reports on its own: a workflow run, a pipeline
export type Run = Outcome & {
  id: string;
  branch: string;
  sha: string;
  // the ref it ran on is a tag, not a branch; branch then holds the tag's name
  tag: boolean;
  // what started it (push, pull_request, schedule) in the forge's words
  event: string;
  actor: string;
  url: string;
  updatedAt: string;
};

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

// what a template is for: opening an issue, or a pull request
export type TemplateKind = 'issue' | 'pr';

// a file in a repository's tree: its path, and the forge's id for its content, which changes whenever the content does
export type TreeFile = { path: string; id: string };

// the artifact a body belongs to and what a write does to it
export type ForgeArtifact = 'issue' | 'pr' | 'release';
export type ForgeAction = 'create' | 'comment' | 'edit' | 'review' | 'merge';

// one write of text people read: the artifact and what the write does to it
export type ForgeWrite = { kind: ForgeArtifact; action: ForgeAction };

export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';
export type MergeMethod = 'merge' | 'squash' | 'rebase';

// one write sift makes on a caller's behalf, with its text and what the forge needs to place it
export type ForgePost =
  | { kind: 'issue'; action: 'create'; title: string; body: string }
  | { kind: 'pr'; action: 'create'; title: string; body: string; base: string; head: string; draft?: boolean }
  | { kind: 'issue' | 'pr'; action: 'comment'; number: number; body: string }
  | { kind: 'issue' | 'pr'; action: 'edit'; number: number; title?: string; body?: string }
  | { kind: 'pr'; action: 'review'; number: number; verdict: ReviewVerdict; body?: string }
  // title and body are the merge commit's subject and message
  | { kind: 'pr'; action: 'merge'; number: number; method: MergeMethod; title?: string; body?: string }
  | { kind: 'release'; action: 'create'; tag: string; target?: string; title?: string; body: string; draft?: boolean; prerelease?: boolean }
  | { kind: 'release'; action: 'edit'; tag: string; title?: string; body?: string };

// an issue or pull request a url on the forge names, with the repo as the forge paths it
export type ForgeLink = { repo: string; kind: 'issue' | 'pr'; number: number };

export interface Forge {
  // the forge's name as prose names it
  readonly name: string;
  // how the forge names each artifact in prose, for the judge: "GitHub issue", "merge request"
  readonly nouns: Record<ForgeArtifact, string>;
  // every write post makes
  readonly writes: ForgeWrite[];

  // the repository the working directory is a checkout of, when it has a remote on this forge
  checkout(): Promise<{ repo: string; defaultBranch: string } | undefined>;
  login(): Promise<string | undefined>;
  defaultBranch(repo: string): Promise<string>;

  // the issue a number names, or the pull request it names with pr set
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
  template(path: string): TemplateKind | undefined;
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
  // every file at a ref (the default branch when unset), as a checkout's git ls-files would list them, each with its content id
  contents(repo: string, ref?: string): Promise<TreeFile[]>;

  // issues and pull requests updated since a stamp (iso 8601), unchanged when nothing moved since the token
  items(repo: string, since: string, token?: string): Promise<Conditional<WatchItem[]>>;
  // the newest ci runs; a repository without ci is unchanged forever
  runs(repo: string, token?: string): Promise<Conditional<Run[]>>;
  // the newest ci runs on one branch, empty for a repository without ci
  branchRuns(repo: string, branch: string): Promise<Run[]>;
  // one ci run by its id, however far it has paged out of the newest runs
  run(repo: string, id: string): Promise<Run>;
  // the open pull request heads; without a token the read always answers changed
  pulls(repo: string, token?: string): Promise<Conditional<PullHead[]>>;
  // the command a caller runs to read the log of a failed ci run; sift reads and judges no ci log itself
  logCommand(repo: string, run: string): string;

  // the issue or pull request a url in the forge's own shape names, undefined for any other text
  parseUrl(url: string): ForgeLink | undefined;

  // makes one write on the named repository, never the one a working directory implies, and answers the url of
  // what it made or changed
  post(repo: string, post: ForgePost): Promise<string>;
  // the write one simple shell command (its words, unquoted) makes through the forge's own cli or api when it
  // sends text people read; undefined for a read, or a write that carries no text
  writeOf(words: string[]): ForgeWrite | undefined;
}
