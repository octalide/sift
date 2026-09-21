import { truncate } from '../tokens.ts';
import type { Subject } from '../packs/types.ts';
import type { Check, Forge } from '../forge/forge.ts';
import type { Git } from '../forge/git.ts';
import { LOG_FORMAT, maxBump, parseCommit, parseLog, requiredBump, type Bump, type ParsedCommit } from './commits.ts';
import { compareVersions, parseTag, SEMVER_PATTERN, type Version } from './version.ts';
import { manifestChanges, manifestFormat, type ManifestChange } from './manifest.ts';
import { lineDiff } from './diff.ts';
import type { GitSource } from './source.ts';
import { tagPatternFor, type RepoConfig } from './config.ts';

const BODY_CAP = 20_000;
const DIFF_CAP = 60_000;
const COMMENT_CAP = 6_000;

import type { ReadLike, ExistsLike } from './source.ts';
export type { ReadLike, ExistsLike } from './source.ts';

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

// the issue a work branch is named after: feat/52, fix/52-short-title, 52-title
export function branchIssue(branch: string): number | undefined {
  const m = /(?:^|\/)(\d+)(?:[-_]|$)/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

// the forge's own relation first, then closing keywords in the body, then an issue number in the branch name
export function linkedOf(relation: number[], body: string, branch: string): number[] {
  if (relation.length > 0) return relation;
  const keywords = linkedIssues(body);
  if (keywords.length > 0) return keywords;
  const fromBranch = branchIssue(branch);
  return fromBranch === undefined ? [] : [fromBranch];
}

export async function issueSubject(forge: Forge, repo: string, n: number, config: RepoConfig): Promise<Subject> {
  const issue = await forge.issue(repo, n);
  const [recent, open, parent] = await Promise.all([forge.comments(repo, 'issue', n, 5), forge.openIssues(repo), forge.parent(repo, n)]);
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
      recent_comments: recent.map((c) => ({ by: c.author.login, text: truncate(c.body, COMMENT_CAP) })),
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
      is_new: recent.length === 0,
      has_others: others.length > 0,
    },
    options: {
      open_issues: Object.fromEntries(others.slice(0, 200).map((i) => [`#${i.number}`, truncate(i.title, 120)])),
      type_labels: Object.fromEntries((config.issues.requiredLabelGroups[0] ?? []).map((l) => [l, `the ${l} label`])),
    },
  };
}

export async function prSubject(forge: Forge, repo: string, n: number, config: RepoConfig): Promise<Subject> {
  const pr = await forge.pull(repo, n);
  const body = pr.body;
  const [diff, recent, checks, log, relation] = await Promise.all([
    forge.diff(repo, n).catch(() => ''),
    forge.comments(repo, 'pr', n, 5),
    forge.checks(repo, pr.head.sha).catch(() => [] as Check[]),
    forge.pullCommits(repo, n).catch(() => []),
    forge.closingIssues(repo, n).catch(() => [] as number[]),
  ]);
  const linked = linkedOf(relation, body, pr.head.branch);
  const issue = linked[0] ? await forge.issue(repo, linked[0]).catch(() => undefined) : undefined;
  // merge commits (a branch updated from its base) are history, not work the convention judges
  const commits = log.filter((c) => !c.merge).map((c) => ({ sha: c.sha, message: c.message }));
  const failed = checks.filter((c) => c.done && !c.ok);
  const pending = checks.filter((c) => !c.done);
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
      recent_comments: recent.map((c) => ({ by: c.author.login, text: truncate(c.body, COMMENT_CAP) })),
      diff: truncate(diff, DIFF_CAP, '\n[diff truncated]'),
    },
    facts: {
      linked,
      base: pr.base,
      head: pr.head.branch,
      sections: sectionsOf(body),
      checks_failed: failed.map((c) => c.name),
      checks_pending: pending.map((c) => c.name),
      commits,
      has_issue: issue !== undefined,
      has_diff: diff.length > 0,
    },
    options: {},
  };
}

export async function commitSubject(git: Git, range: string, config: RepoConfig): Promise<Subject> {
  const raw = await git(range.includes('..') ? ['log', LOG_FORMAT, '--no-merges', range] : ['log', LOG_FORMAT, '-1', range]);
  const commits = parseLog(raw, config.commits.format);
  const single = commits.length === 1 ? commits[0]! : undefined;
  const diff = single ? truncate(await git(['show', '--format=', '--stat', '-p', single.sha]).catch(() => ''), DIFF_CAP, '\n[diff truncated]') : undefined;
  return {
    kind: 'commit',
    ref: range,
    state: {
      range,
      commits: commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, body: truncate(c.body, 2000) })),
      diff,
      conventions: config.commits,
    },
    facts: { commits, single: single !== undefined, has_diff: !!diff },
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

// free text the rules are read against, and when known, what it is about to become in the words the judge reads
export type RulesTarget = { kind: 'pr' | 'issue' | 'commit'; ref: string } | { kind: 'text'; ref: string; about?: string };

// the checkout the rules are read from, and the forge behind it when the session has one
export type RulesHost = { forge?: Forge; git?: Git; repo?: string; read: ReadLike; exists: ExistsLike };

export async function rulesSubject(host: RulesHost, target: RulesTarget, config: RepoConfig): Promise<Subject> {
  const { forge, git, repo, read, exists } = host;
  const rules: { source: string; text: string }[] = [];
  for (const doc of config.rules.docs) {
    const text = await ruleDoc(doc, forge, read, exists);
    if (text === undefined) continue;
    for (const rule of ruleParagraphs(text)) rules.push({ source: doc, text: rule });
  }
  const total = rules.length;
  rules.splice(config.rules.maxRules);
  let subject: Record<string, unknown> = { kind: target.kind, ref: target.ref };
  let about: string | undefined;
  if (forge && repo && target.kind === 'pr') {
    const s = await prSubject(forge, repo, Number(target.ref.replace(/^#/, '')), config);
    subject = { kind: 'pr', ...s.state };
    about = `pull request ${target.ref}`;
  } else if (forge && repo && target.kind === 'issue') {
    const s = await issueSubject(forge, repo, Number(target.ref.replace(/^#/, '')), config);
    subject = { kind: 'issue', ...s.state };
    about = `issue ${target.ref}`;
  } else if (git && target.kind === 'commit') {
    const s = await commitSubject(git, target.ref, config);
    subject = { kind: 'commit', ...s.state };
    about = `commit ${target.ref}`;
  } else if (target.kind === 'text') {
    about = target.about;
    subject = { kind: 'text', ...(about ? { about } : {}), text: truncate(target.ref, BODY_CAP) };
  }
  return {
    kind: 'rules',
    ref: `${target.kind}:${truncate(target.ref, 40)}`,
    state: { subject },
    facts: { rules, has_rules: rules.length > 0, total_rules: total, subject: about ? `The subject (${about})` : 'The subject' },
    options: {},
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

// bullets and short paragraphs that read as rules, headings kept as context prefix
// a rule doc is a path in the checkout or repo:path[@ref] read from the forge; undefined when absent
export async function ruleDoc(doc: string, forge: Forge | undefined, read: ReadLike, exists: ExistsLike): Promise<string | undefined> {
  const remote = /^((?:[\w.-]+\/)+[\w.-]+):([^@]+?)(?:@(.+))?$/.exec(doc);
  if (!remote) return (await exists(doc)) ? read(doc) : undefined;
  if (!forge) return undefined;
  const [, repo, path, ref] = remote;
  return forge.file(repo!, path!, ref);
}

// a markdown table row is one rule, its cells named by the header: "5.x: a; 6.0.0: b"
function tableRows(lines: string[]): string[] {
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  const header = cells(lines[0]!);
  return lines
    .slice(2)
    .map(cells)
    .filter((row) => row.some((c) => c.length > 0))
    .map((row) => row.map((c, i) => (header[i] ? `${header[i]}: ${c}` : c)).join('; '));
}

export function ruleParagraphs(markdown: string): string[] {
  const out: string[] = [];
  let heading = '';
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (text.length < 12 || text.startsWith('```')) return;
    out.push(heading ? `${heading}: ${text}` : text);
  };
  let inCode = false;
  let table: string[] = [];
  const flushTable = () => {
    if (table.length >= 2) for (const row of tableRows(table)) out.push(heading ? `${heading}: ${row}` : row);
    table = [];
  };
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (table.length === 0) flush();
      table.push(line);
      continue;
    }
    flushTable();
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      flush();
      heading = h[1]!.trim();
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flush();
      buffer.push(line.replace(/^\s*([-*+]|\d+\.)\s+/, ''));
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    buffer.push(line.trim());
  }
  flushTable();
  flush();
  return out;
}

export function commitsOf(subject: Subject): ParsedCommit[] {
  return (subject.facts['commits'] as ParsedCommit[] | undefined) ?? [];
}
