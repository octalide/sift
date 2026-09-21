import { parseCommit, scopeHeader, type Bump, type ParsedCommit } from '../github/commits.ts';
import { bumpBetween, bumpVersion, compareVersions, parseTag, parseVersion, type Version } from '../github/version.ts';
import { tagPatternFor, type RepoConfig } from '../github/config.ts';
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
  if (!config.commits.format) return out;
  const scope = config.commits.scopePattern ? new RegExp(config.commits.scopePattern) : undefined;
  for (const c of commits) {
    const id = c.sha.slice(0, 7);
    if (!c.matched) {
      out.push(fail(check, `${id} does not match the commit format: ${c.subject}`));
      continue;
    }
    if (c.type !== undefined && !config.commits.types.includes(c.type)) out.push(fail(check, `${id} uses unknown type ${c.type}`));
    if (scope && !scope.test(scopeHeader(c))) {
      out.push(fail(check, `${id} ${c.scope === undefined ? 'has no scope' : `scope (${c.scope})`}, ${scopeHeader(c)} does not match ${config.commits.scopePattern}`));
    }
    for (const t of c.trailers) {
      if (config.commits.forbidTrailers.some((f) => f.toLowerCase() === t.toLowerCase())) {
        out.push(fail(check, `${id} carries forbidden trailer ${t}`));
      }
    }
  }
  return out;
}

// a proposed version as the user names it: a full tag, or the bare version
function proposedVersion(text: string, release: RepoConfig['release'], versionPattern: string): Version | undefined {
  const patterns = { tagPattern: release.tagPattern ?? tagPatternFor(release.tagPrefix), versionPattern };
  return parseTag(text, patterns) ?? parseVersion(text, versionPattern);
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
  // a pr subject built from a local range carries no forge facts: a check whose fact is absent skips
  'pr.linked': (s, c) => (c.prs.linkIssue && s.facts['linked'] !== undefined && (s.facts['linked'] as number[]).length === 0 ? [fail('pr.linked', 'no linked issue: none related by the forge, no Closes #n in the body, no issue number in the branch name')] : []),
  'pr.target': (s, c) => {
    const targets = c.prs.targets;
    if (targets === undefined || s.facts['base'] === undefined) return [];
    const base = String(s.facts['base']);
    const ok = Array.isArray(targets) ? targets.includes(base) : new RegExp(targets).test(base);
    return ok ? [] : [fail('pr.target', `targets ${base}, expected ${Array.isArray(targets) ? targets.join(' or ') : `a branch matching ${targets}`}`)];
  },
  'pr.branch': (s, c) => {
    if (!c.branches.pattern) return [];
    const head = String(s.facts['head'] ?? '');
    return new RegExp(c.branches.pattern).test(head) ? [] : [warn('pr.branch', `branch ${head} does not match ${c.branches.pattern}`)];
  },
  'pr.ci': (s) => {
    if (s.facts['checks_failed'] === undefined) return [];
    const failed = s.facts['checks_failed'] as string[];
    const pending = (s.facts['checks_pending'] as string[]) ?? [];
    return [
      ...failed.map((n) => fail('pr.ci', `check failed: ${n}`)),
      ...(pending.length > 0 ? [info('pr.ci', `checks pending: ${pending.join(', ')}`)] : []),
    ];
  },
  'pr.template': (s, c) => {
    if (s.facts['sections'] === undefined) return [];
    const { missing, empty } = sectionsFilled(s.facts['sections'] as Record<string, string>, c.prs.templateSections);
    return [
      ...missing.map((m) => warn('pr.template', `missing section: ${m}`)),
      ...empty.map((m) => warn('pr.template', `empty section: ${m}`)),
    ];
  },
  'pr.drift': (s) => {
    const drift = (s.facts['drift'] as { path: string }[] | undefined) ?? [];
    return drift.length > 0 ? [warn('pr.drift', `also changed on the base since the branch point: ${drift.map((d) => d.path).join(', ')}`)] : [];
  },
  'pr.commits': (s, c) => commitFindings('pr.commits', ((s.facts['commits'] as { sha: string; message: string }[]) ?? []).map((x) => parseCommit(x.sha, x.message, c.commits.format)), c),
  'commit.format': (s, c) => commitFindings('commit.format', (s.facts['commits'] as ParsedCommit[]) ?? [], c),
  'release.bump': (s, c) => {
    const pattern = c.release.versionPattern;
    if (!pattern) return [];
    const bump = s.facts['bump'] as Bump;
    const version = s.facts['version'] as Version | undefined;
    const manifests = (s.facts['manifests'] as { path: string; key: string; from: string | null; to: string | null }[]) ?? [];
    const commitBump = (s.facts['commitBump'] as Bump | undefined) ?? bump;
    const manifestBump = (s.facts['manifestBump'] as Bump | undefined) ?? 'none';
    const unparsed = ((s.facts['manifestsUnparsed'] as string[] | undefined) ?? []).map((p) => warn('release.bump', `${p} is not toml, json or yaml, its keys match nothing (use pattern)`));
    if (!s.facts['has_commits']) return [...unparsed, info('release.bump', 'no commits since the last tag')];
    if (bump === 'none') return [...unparsed, warn('release.bump', 'nothing since the last tag calls for a release (no feat, fix, breaking change or manifest change)')];
    const because = [
      commitBump !== 'none' ? `commits ${commitBump}` : '',
      ...manifests.map((m) => `${m.path} ${m.key} ${m.from ?? 'unset'} -> ${m.to ?? 'unset'} (${manifestBump})`),
    ].filter(Boolean);
    if (!version) return [...unparsed, info('release.bump', `required bump: ${bump} (no previous release tag to compute from), from ${because.join('; ')}`)];
    // a pattern without major, minor and patch groups (calver) has no next version to compute, only an order to keep
    const next = bumpVersion(version, bump, pattern);
    const findings = [...unparsed, info('release.bump', `required bump: ${bump}${next ? `, next version ${c.release.tagPrefix}${next}` : ''}, from ${because.join('; ')}`)];
    const proposed = s.facts['proposed'] as string | undefined;
    if (proposed) {
      const p = proposedVersion(proposed, c.release, pattern);
      const between = p && bumpBetween(version, p);
      if (!p) findings.push(fail('release.bump', `${proposed} does not match the version pattern ${pattern}`));
      else if (between === undefined && compareVersions(p, version) <= 0) findings.push(fail('release.bump', `${proposed} is not newer than ${version.raw}`));
      else if (between !== undefined && between !== bump) findings.push(fail('release.bump', `${proposed} is a ${between} bump, the changes require ${bump}`));
    }
    return findings;
  },
  'release.changelog': (s, c) => {
    if (!c.release.changelog) return [];
    if (!s.facts['changelogPath']) return [warn('release.changelog', `${c.release.changelog} not found`)];
    const since = s.facts['lastTag'] ? `since ${String(s.facts['lastTag'])}` : 'and is empty';
    return s.facts['changelog_changed'] ? [] : [warn('release.changelog', `${c.release.changelog} is unchanged ${since}`)];
  },
  'release.commits': (s, c) => commitFindings('release.commits', (s.facts['commits'] as ParsedCommit[]) ?? [], c),
  'tree.indexed': (s) => {
    const files = Number(s.facts['total_files'] ?? 0);
    const dirs = ((s.facts['dirs'] as unknown[] | undefined) ?? []).length;
    const skipped = Number(s.facts['skipped_files'] ?? 0);
    if (files === 0) return [warn('tree.indexed', skipped > 0 ? `no files indexed, ${skipped} skipped as ignored, binary or over the size bound` : 'no files indexed: not a checkout, or git ls-files is empty')];
    return [info('tree.indexed', `${files} files in ${dirs} directories indexed, ${skipped} skipped`)];
  },
  'rules.present': (s, c) => {
    if (!s.facts['has_rules']) return [info('rules.present', 'no rule documents found in the repo')];
    const total = Number(s.facts['total_rules'] ?? 0);
    return total > c.rules.maxRules ? [warn('rules.present', `${c.rules.maxRules} of ${total} rules used, raise rules.maxRules to judge the rest`)] : [];
  },
};
