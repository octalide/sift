import { truncate } from '../tokens.ts';
import type { Subject } from '../packs/types.ts';
import { refusal } from '../packs/subject.ts';
import type { Check, Comment, Forge } from '../forge/forge.ts';
import type { Git } from '../forge/git.ts';
import { LOG_FORMAT, maxBump, parseCommit, parseLog, requiredBump, splitLog, type Bump, type ParsedCommit } from './commits.ts';
import { compareVersions, parseTag, SEMVER_PATTERN, type Version } from './version.ts';
import { manifestChanges, manifestFormat, type ManifestChange } from './manifest.ts';
import { driftOf, lineDiff } from './diff.ts';
import type { GitSource } from './source.ts';
import { tagPatternFor, type RepoConfig } from './config.ts';
import { discoverRules, type RuleSource } from '../rules/discover.ts';
import type { Judge } from '../judge/types.ts';
import type { StoreLike } from '../log.ts';

const BODY_CAP = 20_000;
const COMMENT_CAP = 6_000;
// what a thread may add to the state: the body's cap twice over, so a long discussion cannot crowd out the rest
const THREAD_BUDGET = 40_000;


export function sectionsOf(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = '';
  for (const line of markdown.split('\n')) {
    const h = /^#{1,4}\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1]!.trim();
      sections[current] = '';
    } else if (current) {
      sections[current] += `${line}\n`;
    }
  }
  return sections;
}

export function linkedIssues(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) out.add(Number(m[1]));
  return [...out];
}

// the issue a work branch is named after: the issue group of the branch pattern when it has one,
// otherwise the number segment of feat/52, fix/52-short-title, 52-title
export function branchIssue(branch: string, pattern?: string): number | undefined {
  const named = pattern ? new RegExp(pattern).exec(branch)?.groups?.['issue'] : undefined;
  if (named !== undefined) return Number(named);
  const m = /(?:^|\/)(\d+)(?:[-_]|$)/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

// the forge's own relation first, then closing keywords in the body, then an issue number in the branch name
export function linkedOf(relation: number[], body: string, branch: string, pattern?: string): number[] {
  if (relation.length > 0) return relation;
  const keywords = linkedIssues(body);
  if (keywords.length > 0) return keywords;
  const fromBranch = branchIssue(branch, pattern);
  return fromBranch === undefined ? [] : [fromBranch];
}

// one comment as the judge reads it: who, their standing in the forge's words, when, and what they said
export type ThreadComment = { by: string; association: string | null; at: string; text: string };

// the comments that can amend an issue or pull request: its author's and its maintainers'
export function amends(forge: Pick<Forge, 'maintains'>, author: string, by: string, association: string | undefined): boolean {
  return by === author || forge.maintains(association);
}

// the thread under a budget: the author's and maintainers' comments first, newest first, then the newest of
// the rest; what is kept goes out oldest first, so a later ruling reads as later
export function threadOf(forge: Pick<Forge, 'maintains'>, author: string, comments: Comment[], budget = THREAD_BUDGET): ThreadComment[] {
  const order = comments.map((c, i) => ({ c, i })).reverse();
  const standing = ({ c }: { c: Comment }) => amends(forge, author, c.author.login, c.association);
  const ranked = [...order.filter(standing), ...order.filter((x) => !standing(x))];
  const kept: { c: Comment; i: number; text: string }[] = [];
  let left = budget;
  for (const { c, i } of ranked) {
    const text = truncate(c.body, COMMENT_CAP);
    if (text.length > left) continue;
    left -= text.length;
    kept.push({ c, i, text });
  }
  return kept.sort((a, b) => a.i - b.i).map(({ c, text }) => ({ by: c.author.login, association: c.association ?? null, at: c.createdAt, text }));
}

// the author's and maintainers' comments a judge can name as the one that settles something, keyed by who and when
export function rulingsOf(forge: Pick<Forge, 'maintains'>, author: string, thread: ThreadComment[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of thread) {
    if (!amends(forge, author, c.by, c.association ?? undefined)) continue;
    out[`${c.by} at ${c.at}`] = truncate(c.text.replace(/\s+/g, ' ').trim(), 160);
  }
  return out;
}

// an issue graded for a pack of the given kind; a number that names a pull request is refused with the forms that pack takes
export async function issueSubject(forge: Forge, repo: string, n: number, config: RepoConfig, pack: 'issue' | 'rules' = 'issue'): Promise<Subject> {
  const issue = await forge.issue(repo, n);
  if (issue.pr) throw refusal(pack, `#${n}`, `subject is ${repo}#${n}, a pull request, not an issue`, forge);
  const [all, open, parent] = await Promise.all([forge.comments(repo, 'issue', n), forge.openIssues(repo), forge.parent(repo, n)]);
  const comments = threadOf(forge, issue.author.login, all);
  const rulings = rulingsOf(forge, issue.author.login, comments);
  const body = issue.body;
  const sections = sectionsOf(body);
  const labels = issue.labels;
  const others = open.filter((i) => i.number !== n);
  return {
    kind: 'issue',
    ref: `${repo}#${n}`,
    state: {
      repo,
      number: n,
      title: issue.title,
      body: truncate(body, BODY_CAP),
      labels,
      milestone: issue.milestone ?? null,
      author: issue.author.login,
      association: issue.association ?? null,
      sections: Object.keys(sections),
      comments,
      conventions: {
        template_sections: config.issues.templateSections,
        required_label_groups: config.issues.requiredLabelGroups,
      },
    },
    facts: {
      labels,
      milestone: issue.milestone,
      sections,
      parent,
      is_new: all.length === 0,
      has_others: others.length > 0,
      has_rulings: Object.keys(rulings).length > 0,
    },
    options: {
      rulings,
      open_issues: Object.fromEntries(others.slice(0, 200).map((i) => [`#${i.number}`, truncate(i.title, 120)])),
      type_labels: Object.fromEntries((config.issues.requiredLabelGroups[0] ?? []).map((l) => [l, `the ${l} label`])),
    },
  };
}

export async function prSubject(forge: Forge, repo: string, n: number, config: RepoConfig): Promise<Subject> {
  const pr = await forge.pull(repo, n);
  const body = pr.body;
  const [diff, all, checks, log, relation, baseDiff] = await Promise.all([
    forge.diff(repo, n).catch(() => ''),
    forge.comments(repo, 'pr', n),
    forge.checks(repo, pr.head.sha).catch(() => [] as Check[]),
    forge.pullCommits(repo, n).catch(() => []),
    forge.closingIssues(repo, n).catch(() => [] as number[]),
    forge.compareDiff(repo, pr.head.sha, pr.base).catch(() => ''),
  ]);
  const linked = linkedOf(relation, body, pr.head.branch, config.branches.pattern);
  const issue = linked[0] ? await forge.issue(repo, linked[0]).catch(() => undefined) : undefined;
  // merge commits (a branch updated from its base) are history, not work the convention judges
  const commits = log.filter((c) => !c.merge).map((c) => ({ sha: c.sha, message: c.message }));
  const failed = checks.filter((c) => c.done && !c.ok);
  const pending = checks.filter((c) => !c.done);
  const drift = driftOf(diff, baseDiff);
  return {
    kind: 'pr',
    ref: `${repo}#${n}`,
    state: {
      repo,
      number: n,
      title: pr.title,
      body: truncate(body, BODY_CAP),
      author: pr.author.login,
      base: pr.base,
      head: pr.head.branch,
      draft: pr.draft,
      stats: pr.stats,
      linked_issue: issue ? { number: issue.number, title: issue.title, body: truncate(issue.body, BODY_CAP) } : null,
      commits: commits.map((c) => c.message.split('\n')[0]),
      checks: { failed: failed.map((c) => c.name), pending: pending.map((c) => c.name), total: checks.length },
      comments: threadOf(forge, pr.author.login, all),
      drift,
    },
    facts: {
      linked,
      base: pr.base,
      head: pr.head.branch,
      sections: sectionsOf(body),
      checks_failed: failed.map((c) => c.name),
      checks_pending: pending.map((c) => c.name),
      commits,
      drift,
      has_issue: issue !== undefined,
      has_drift: drift.length > 0,
    },
    options: {},
  };
}

// where a range subject reads its issue from, when the checkout has a forge behind it
export type IssueSource = { forge: Forge; repo: string };

// a pull request that does not exist yet: base..head in the checkout, graded as the pr it would open.
// the forge facts a pr carries (its relation, target, checks, template body) are left out, so the checks
// that read them skip; the issue comes from the head branch name
export async function prRangeSubject(git: Git, range: string, config: RepoConfig, issues?: IssueSource): Promise<Subject> {
  const sep = range.indexOf('..');
  const base = range.slice(0, sep);
  const head = range.slice(sep + 2) || 'HEAD';
  if (!base) throw new Error(`pr range ${range}: no base, expected base..head`);
  const [diff, baseDiff, raw, branch] = await Promise.all([
    git(['diff', `${base}...${head}`]),
    git(['diff', `${head}...${base}`]),
    git(['log', LOG_FORMAT, '--no-merges', `${base}..${head}`]),
    git(['rev-parse', '--abbrev-ref', head]).then((s) => s.trim()),
  ]);
  const commits = splitLog(raw);
  const number = branchIssue(branch, config.branches.pattern);
  const issue = number !== undefined && issues ? await issues.forge.issue(issues.repo, number).catch(() => undefined) : undefined;
  const drift = driftOf(diff, baseDiff);
  return {
    kind: 'pr',
    ref: range,
    state: {
      range,
      base,
      head: branch,
      linked_issue: issue ? { number: issue.number, title: issue.title, body: truncate(issue.body, BODY_CAP) } : null,
      commits: commits.map((c) => c.message.split('\n')[0]),
      drift,
    },
    facts: {
      head: branch,
      commits,
      drift,
      has_issue: issue !== undefined,
      has_drift: drift.length > 0,
    },
    options: {},
  };
}

export async function commitSubject(git: Git, range: string, config: RepoConfig): Promise<Subject> {
  const raw = await git(range.includes('..') ? ['log', LOG_FORMAT, '--no-merges', range] : ['log', LOG_FORMAT, '-1', range]);
  const commits = parseLog(raw, config.commits.format);
  return {
    kind: 'commit',
    ref: range,
    state: {
      range,
      commits: commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, body: truncate(c.body, 2000) })),
      conventions: config.commits,
    },
    facts: { commits, single: commits.length === 1 },
    options: {
      commit_types: Object.fromEntries(config.commits.types.map((t) => [t, `a ${t} change`])),
    },
  };
}

// the highest release tag, not the nearest ancestor: release tags sit on main and are unreachable from dev
// without a version pattern the tags are still ordered as semver, so the release has a last tag to read commits from
export function lastReleaseTag(tags: string[], release: RepoConfig['release']): { tag: string; version: Version } | undefined {
  const patterns = { tagPattern: release.tagPattern ?? tagPatternFor(release.tagPrefix), versionPattern: release.versionPattern ?? SEMVER_PATTERN };
  let best: { tag: string; version: Version } | undefined;
  for (const tag of tags) {
    const version = parseTag(tag, patterns);
    if (!version) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best;
}

export async function releaseSubject(source: GitSource, config: RepoConfig): Promise<Subject> {
  const last = lastReleaseTag(await source.tags(), config.release);
  const lastTag = last?.tag;
  const range = lastTag ? `${lastTag}..${source.head}` : source.head;
  const commits = (await source.log(lastTag)).map((c) => parseCommit(c.sha, c.message, config.commits.format));
  const version = config.release.versionPattern ? last?.version : undefined;
  const commitBump = requiredBump(commits, config.commits.bumps ?? {}, version, config.release.zeroVerBreaking);
  const manifests: ManifestChange[] = [];
  const unparsed: string[] = [];
  for (const rule of config.release.manifests) {
    if ((rule.keys ?? []).length > 0 && !manifestFormat(rule.path)) unparsed.push(rule.path);
    manifests.push(...manifestChanges(rule, lastTag ? await source.show(lastTag, rule.path) : undefined, await source.show(source.head, rule.path)));
  }
  const manifestBump = manifests.reduce<Bump>((acc, m) => maxBump(acc, m.bump), 'none');
  const bump = maxBump(commitBump, manifestBump);
  const changelog = config.release.changelog ? await source.show(source.head, config.release.changelog) : undefined;
  const changelogPath = changelog !== undefined ? config.release.changelog : undefined;
  const changelogBefore = changelogPath && lastTag ? await source.show(lastTag, changelogPath) : undefined;
  const diff = lineDiff(changelogBefore ?? '', changelog ?? '');
  const changelogAdded = diff.added.join('\n');
  return {
    kind: 'release',
    ref: range,
    state: {
      last_tag: lastTag ?? null,
      commits: commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, breaking: c.breaking, body: truncate(c.body, 1500) })),
      required_bump: bump,
      manifest_changes: manifests.map((m) => ({ path: m.path, key: m.key, from: m.from, to: m.to })),
      changelog_diff: truncate(diff.text, 8000),
    },
    facts: {
      lastTag,
      version,
      commits,
      bump,
      commitBump,
      manifestBump,
      manifests,
      manifestsUnparsed: unparsed,
      changelogPath,
      changelogAdded,
      changelog_changed: diff.text.length > 0,
      has_commits: commits.length > 0 || manifests.length > 0,
    },
    options: {},
  };
}

// what the rules are read against: an issue, or free text and, when known, what it is about to become in the words the judge reads
export type RulesTarget = { kind: 'issue'; number: number } | { kind: 'text'; ref: string; about?: string };

// the checkout or repository the rules are read from, the judge that discovers them and the store that caches them
export type RulesHost = { forge?: Forge; repo?: string; source: RuleSource; judge: Judge; store: StoreLike };

export async function rulesSubject(host: RulesHost, target: RulesTarget, config: RepoConfig): Promise<Subject> {
  const { forge, repo } = host;
  const ref = target.kind === 'text' ? target.ref : `#${target.number}`;
  let subject: Record<string, unknown> = { kind: target.kind, ref };
  let about: string | undefined;
  if (forge && repo && target.kind === 'issue') {
    const s = await issueSubject(forge, repo, target.number, config, 'rules');
    subject = { kind: 'issue', ...s.state };
    about = `issue ${ref}`;
  } else if (target.kind === 'text') {
    about = target.about;
    subject = { kind: 'text', ...(about ? { about } : {}), text: truncate(target.ref, BODY_CAP) };
  }
  // the subject is read, and a pull request refused, before discovery spends judge calls
  const found = await discoverRules(host.source, config.rules, host.judge, host.store);
  const rules = [...found.rules];
  const total = rules.length;
  rules.splice(config.rules.maxRules);
  return {
    kind: 'rules',
    ref: `${target.kind}:${truncate(ref, 40)}`,
    state: { subject },
    facts: {
      rules,
      has_rules: rules.length > 0,
      total_rules: total,
      docs: found.docs,
      candidates: found.candidates,
      cached: found.cached,
      subject: about ? `The subject (${about})` : 'The subject',
    },
    options: {},
    ...(found.error === undefined ? {} : { judgeError: `rule discovery: ${found.error}` }),
  };
}

// a plan for an issue: the issue's title and body beside the plan text, so the judge reads the plan against what was asked
export async function planSubject(forge: Forge, repo: string, n: number, plan: string): Promise<Subject> {
  const issue = await forge.issue(repo, n);
  return {
    kind: 'plan',
    ref: `${repo}#${n}`,
    state: {
      repo,
      number: n,
      issue: { title: issue.title, body: truncate(issue.body, BODY_CAP) },
      plan: truncate(plan, BODY_CAP),
    },
    facts: { has_plan: plan.trim().length > 0 },
    options: {},
  };
}

export function textSubject(text: string, context?: string): Subject {
  return {
    kind: 'text',
    ref: truncate(text, 40),
    state: { text: truncate(text, BODY_CAP), context: context ? truncate(context, BODY_CAP) : null },
    facts: {},
    options: {},
  };
}

export function commitsOf(subject: Subject): ParsedCommit[] {
  return (subject.facts['commits'] as ParsedCommit[] | undefined) ?? [];
}
