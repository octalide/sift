import { truncate } from '../tokens.ts';
import type { Subject } from '../packs/types.ts';
import { LOG_FORMAT, parseLog, parseSemver, requiredBump, type ParsedCommit } from './commits.ts';
import type { RepoConfig } from './config.ts';
import type { Gh } from './gh.ts';

const BODY_CAP = 20_000;
const DIFF_CAP = 60_000;
const COMMENT_CAP = 6_000;

export type ReadLike = (path: string) => Promise<string>;
export type ExistsLike = (path: string) => Promise<boolean>;

type GhUser = { login: string; type?: string };
type GhLabel = { name: string };
type GhIssue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: GhUser;
  labels: GhLabel[];
  milestone: { title: string } | null;
  html_url: string;
  pull_request?: unknown;
  author_association?: string;
};
type GhComment = { user: GhUser; body: string; created_at: string };
type GhPull = GhIssue & {
  base: { ref: string };
  head: { ref: string; sha: string };
  draft: boolean;
  merged: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
};
type GhCheck = { name: string; status: string; conclusion: string | null };

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

async function comments(gh: Gh, repo: string, n: number, last = 5): Promise<GhComment[]> {
  const all = await gh.json<GhComment[]>(`repos/${repo}/issues/${n}/comments?per_page=100`);
  return all.slice(-last);
}

export async function issueSubject(gh: Gh, repo: string, n: number, config: RepoConfig): Promise<Subject> {
  const issue = await gh.json<GhIssue>(`repos/${repo}/issues/${n}`);
  const [recent, open] = await Promise.all([
    comments(gh, repo, n),
    gh.json<GhIssue[]>(`repos/${repo}/issues?state=open&per_page=100`),
  ]);
  const body = issue.body ?? '';
  const sections = sectionsOf(body);
  const labels = issue.labels.map((l) => l.name);
  const others = open.filter((i) => i.number !== n && !i.pull_request);
  let parent: number | undefined;
  try {
    const p = await gh.json<{ number: number } | null>(`repos/${repo}/issues/${n}/parent`);
    parent = p?.number;
  } catch {
    parent = undefined;
  }
  return {
    kind: 'issue',
    ref: `${repo}#${n}`,
    state: {
      repo,
      number: n,
      title: issue.title,
      body: truncate(body, BODY_CAP),
      labels,
      milestone: issue.milestone?.title ?? null,
      author: issue.user.login,
      association: issue.author_association ?? null,
      sections: Object.keys(sections),
      recent_comments: recent.map((c) => ({ by: c.user.login, text: truncate(c.body, COMMENT_CAP) })),
      conventions: {
        template_sections: config.issues.templateSections,
        required_label_groups: config.issues.requiredLabelGroups,
      },
    },
    facts: {
      labels,
      milestone: issue.milestone?.title,
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

export async function prSubject(gh: Gh, repo: string, n: number, config: RepoConfig): Promise<Subject> {
  const pr = await gh.json<GhPull>(`repos/${repo}/pulls/${n}`);
  const body = pr.body ?? '';
  const linked = linkedIssues(body);
  const [diff, recent, checks, log] = await Promise.all([
    gh.text(`repos/${repo}/pulls/${n}`, 'application/vnd.github.diff').catch(() => ''),
    comments(gh, repo, n),
    gh
      .json<{ check_runs: GhCheck[] }>(`repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`)
      .then((r) => r.check_runs)
      .catch(() => [] as GhCheck[]),
    gh
      .json<{ sha: string; commit: { message: string } }[]>(`repos/${repo}/pulls/${n}/commits?per_page=100`)
      .catch(() => []),
  ]);
  const issue = linked[0] ? await gh.json<GhIssue>(`repos/${repo}/issues/${linked[0]}`).catch(() => undefined) : undefined;
  const commits = log.map((c) => ({ sha: c.sha, message: c.commit.message }));
  const failed = checks.filter((c) => c.status === 'completed' && c.conclusion && !['success', 'skipped', 'neutral'].includes(c.conclusion));
  const pending = checks.filter((c) => c.status !== 'completed');
  return {
    kind: 'pr',
    ref: `${repo}#${n}`,
    state: {
      repo,
      number: n,
      title: pr.title,
      body: truncate(body, BODY_CAP),
      author: pr.user.login,
      base: pr.base.ref,
      head: pr.head.ref,
      draft: pr.draft,
      stats: { additions: pr.additions, deletions: pr.deletions, files: pr.changed_files },
      linked_issue: issue ? { number: issue.number, title: issue.title, body: truncate(issue.body ?? '', BODY_CAP) } : null,
      commits: commits.map((c) => c.message.split('\n')[0]),
      checks: { failed: failed.map((c) => c.name), pending: pending.map((c) => c.name), total: checks.length },
      recent_comments: recent.map((c) => ({ by: c.user.login, text: truncate(c.body, COMMENT_CAP) })),
      diff: truncate(diff, DIFF_CAP, '\n[diff truncated]'),
    },
    facts: {
      linked,
      base: pr.base.ref,
      head: pr.head.ref,
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

export async function commitSubject(gh: Gh, range: string, config: RepoConfig): Promise<Subject> {
  const raw = await gh.git(range.includes('..') ? ['log', LOG_FORMAT, range] : ['log', LOG_FORMAT, '-1', range]);
  const commits = parseLog(raw);
  const single = commits.length === 1 ? commits[0]! : undefined;
  const diff = single ? truncate(await gh.git(['show', '--format=', '--stat', '-p', single.sha]).catch(() => ''), DIFF_CAP, '\n[diff truncated]') : undefined;
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

export async function releaseSubject(gh: Gh, config: RepoConfig, read: ReadLike, exists: ExistsLike): Promise<Subject> {
  let lastTag: string | undefined;
  try {
    lastTag = (await gh.git(['describe', '--tags', '--abbrev=0'])).trim() || undefined;
  } catch {
    lastTag = undefined;
  }
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const commits = parseLog(await gh.git(['log', LOG_FORMAT, range]));
  const bump = requiredBump(commits);
  const version = lastTag ? parseSemver(lastTag, config.release.tagPrefix) : undefined;
  const changelogPath = config.release.changelog ?? (await firstExisting(exists, ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md']));
  const changelog = changelogPath && (await exists(changelogPath)) ? await read(changelogPath) : '';
  const unreleased = topSection(changelog);
  return {
    kind: 'release',
    ref: range,
    state: {
      last_tag: lastTag ?? null,
      commits: commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, breaking: c.breaking, body: truncate(c.body, 1500) })),
      required_bump: bump,
      changelog_top: truncate(unreleased, 8000),
    },
    facts: { lastTag, version, commits, bump, changelogPath, unreleased, has_commits: commits.length > 0 },
    options: {},
  };
}

export async function rulesSubject(
  gh: Gh | undefined,
  repo: string | undefined,
  target: { kind: 'pr' | 'issue' | 'text' | 'commit'; ref: string },
  config: RepoConfig,
  read: ReadLike,
  exists: ExistsLike,
): Promise<Subject> {
  const rules: { source: string; text: string }[] = [];
  for (const doc of config.rules.docs) {
    if (!(await exists(doc))) continue;
    for (const rule of ruleParagraphs(await read(doc))) rules.push({ source: doc, text: rule });
  }
  let subject: Record<string, unknown> = { kind: target.kind, ref: target.ref };
  if (gh && repo && target.kind === 'pr') {
    const s = await prSubject(gh, repo, Number(target.ref.replace(/^#/, '')), config);
    subject = { kind: 'pr', ...s.state };
  } else if (gh && repo && target.kind === 'issue') {
    const s = await issueSubject(gh, repo, Number(target.ref.replace(/^#/, '')), config);
    subject = { kind: 'issue', ...s.state };
  } else if (gh && target.kind === 'commit') {
    const s = await commitSubject(gh, target.ref, config);
    subject = { kind: 'commit', ...s.state };
  } else {
    subject = { kind: 'text', text: truncate(target.ref, BODY_CAP) };
  }
  return {
    kind: 'rules',
    ref: `${target.kind}:${truncate(target.ref, 40)}`,
    state: { subject, rules: rules.map((r, i) => ({ id: `r${i + 1}`, source: r.source, text: r.text })) },
    facts: { rules, has_rules: rules.length > 0 },
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

async function firstExisting(exists: ExistsLike, paths: string[]): Promise<string | undefined> {
  for (const p of paths) if (await exists(p)) return p;
  return undefined;
}

// the newest changelog section: everything under the first second-level heading
export function topSection(changelog: string): string {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => /^##\s/.test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n').trim();
}

// bullets and short paragraphs that read as rules, headings kept as context prefix
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
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
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
  flush();
  return out.slice(0, 120);
}

export function commitsOf(subject: Subject): ParsedCommit[] {
  return (subject.facts['commits'] as ParsedCommit[] | undefined) ?? [];
}
