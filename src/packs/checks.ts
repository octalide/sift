import { bumpBetween, bumpVersion, parseCommit, parseSemver, type Bump, type ParsedCommit } from '../github/commits.ts';
import type { RepoConfig } from '../github/config.ts';
import type { Finding, Subject } from './types.ts';

export type Check = (subject: Subject, config: RepoConfig) => Finding[];

const fail = (check: string, message: string): Finding => ({ check, severity: 'fail', message });
const warn = (check: string, message: string): Finding => ({ check, severity: 'warn', message });
const info = (check: string, message: string): Finding => ({ check, severity: 'info', message });

function sectionsFilled(sections: Record<string, string>, required: string[]): { missing: string[]; empty: string[] } {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const name of required) {
    const key = Object.keys(sections).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key === undefined) missing.push(name);
    else if (sections[key]!.replace(/<!--[\s\S]*?-->/g, '').trim().length < 3) empty.push(name);
  }
  return { missing, empty };
}

function commitFindings(check: string, commits: ParsedCommit[], config: RepoConfig): Finding[] {
  const out: Finding[] = [];
  if (config.commits.convention === 'none') return out;
  for (const c of commits) {
    const id = c.sha.slice(0, 7);
    if (!c.conventional) {
      out.push(fail(check, `${id} is not a conventional commit: ${c.subject}`));
      continue;
    }
    if (!config.commits.types.includes(c.type!)) out.push(fail(check, `${id} uses unknown type ${c.type}`));
    if (config.commits.scope === 'issue' && c.scope !== undefined && !/^#\d+$/.test(c.scope) && c.type !== 'chore') {
      out.push(fail(check, `${id} scope must be #<issue>, got (${c.scope})`));
    }
    if (config.commits.scope === 'none' && c.scope !== undefined) out.push(fail(check, `${id} must not carry a scope`));
    for (const t of c.trailers) {
      if (config.commits.forbidTrailers.some((f) => f.toLowerCase() === t.toLowerCase())) {
        out.push(fail(check, `${id} carries forbidden trailer ${t}`));
      }
    }
  }
  return out;
}

export const CHECKS: Record<string, Check> = {
  'issue.labels': (s, c) => {
    const labels = (s.facts['labels'] as string[]) ?? [];
    return c.issues.requiredLabelGroups
      .filter((group) => !group.some((l) => labels.includes(l)))
      .map((group) => fail('issue.labels', `needs one of: ${group.join(', ')}`));
  },
  'issue.milestone': (s, c) => (c.issues.milestone && !s.facts['milestone'] ? [fail('issue.milestone', 'no milestone set')] : []),
  'issue.template': (s, c) => {
    const { missing, empty } = sectionsFilled((s.facts['sections'] as Record<string, string>) ?? {}, c.issues.templateSections);
    return [
      ...missing.map((m) => fail('issue.template', `missing section: ${m}`)),
      ...empty.map((m) => warn('issue.template', `empty section: ${m}`)),
    ];
  },
  'issue.parent': (s, c) => {
    const labels = (s.facts['labels'] as string[]) ?? [];
    const needs = c.issues.childLabels.some((l) => labels.includes(l));
    return needs && s.facts['parent'] === undefined ? [fail('issue.parent', 'labeled as a child but has no parent sub-issue link')] : [];
  },
  'pr.linked': (s, c) => (c.prs.linkIssue && ((s.facts['linked'] as number[]) ?? []).length === 0 ? [fail('pr.linked', 'no Closes #n in the body')] : []),
  'pr.target': (s, c) => (c.prs.target && s.facts['base'] !== c.prs.target ? [fail('pr.target', `targets ${String(s.facts['base'])}, expected ${c.prs.target}`)] : []),
  'pr.branch': (s, c) => {
    if (!c.branches.pattern) return [];
    const head = String(s.facts['head'] ?? '');
    return new RegExp(c.branches.pattern).test(head) ? [] : [warn('pr.branch', `branch ${head} does not match ${c.branches.pattern}`)];
  },
  'pr.ci': (s) => {
    const failed = (s.facts['checks_failed'] as string[]) ?? [];
    const pending = (s.facts['checks_pending'] as string[]) ?? [];
    return [
      ...failed.map((n) => fail('pr.ci', `check failed: ${n}`)),
      ...(pending.length > 0 ? [info('pr.ci', `checks pending: ${pending.join(', ')}`)] : []),
    ];
  },
  'pr.template': (s, c) => {
    const { missing, empty } = sectionsFilled((s.facts['sections'] as Record<string, string>) ?? {}, c.prs.templateSections);
    return [
      ...missing.map((m) => warn('pr.template', `missing section: ${m}`)),
      ...empty.map((m) => warn('pr.template', `empty section: ${m}`)),
    ];
  },
  'pr.commits': (s, c) => commitFindings('pr.commits', ((s.facts['commits'] as { sha: string; message: string }[]) ?? []).map((x) => parseCommit(x.sha, x.message)), c),
  'commit.format': (s, c) => commitFindings('commit.format', (s.facts['commits'] as ParsedCommit[]) ?? [], c),
  'release.bump': (s, c) => {
    if (!c.release.scheme) return [];
    const bump = s.facts['bump'] as Bump;
    const version = s.facts['version'] as [number, number, number] | undefined;
    if (!s.facts['has_commits']) return [info('release.bump', 'no commits since the last tag')];
    if (bump === 'none') return [warn('release.bump', 'nothing since the last tag calls for a release (no feat, fix or breaking change)')];
    if (!version) return [info('release.bump', `required bump: ${bump} (no previous semver tag to compute from)`)];
    const next = bumpVersion(version, bump);
    const findings = [info('release.bump', `required bump: ${bump}, next version ${c.release.tagPrefix}${next.join('.')}`)];
    const proposed = s.facts['proposed'] as string | undefined;
    if (proposed) {
      const p = parseSemver(proposed, c.release.tagPrefix);
      if (!p) findings.push(fail('release.bump', `${proposed} is not semver`));
      else if (bumpBetween(version, p) !== bump && !(version[0] === 0 && bump === 'major' && bumpBetween(version, p) === 'minor')) {
        findings.push(fail('release.bump', `${proposed} is a ${bumpBetween(version, p)} bump, commits require ${bump}`));
      }
    }
    return findings;
  },
  'release.changelog': (s, c) => {
    if (!c.release.changelog) return [];
    if (!s.facts['changelogPath']) return [warn('release.changelog', `${c.release.changelog} not found`)];
    const top = String(s.facts['unreleased'] ?? '');
    return top.length === 0 ? [warn('release.changelog', 'changelog has no section to promote')] : [];
  },
  'release.commits': (s, c) => commitFindings('release.commits', (s.facts['commits'] as ParsedCommit[]) ?? [], c),
  'rules.present': (s) => (s.facts['has_rules'] ? [] : [info('rules.present', 'no rule documents found in the repo')]),
};
