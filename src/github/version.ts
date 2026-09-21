import type { Bump } from './commits.ts';

// a version is whatever the configured pattern names: the numeric groups order it, major, minor and patch bump it
export type Version = {
  raw: string;
  groups: Record<string, string>;
  // the numeric named groups in match order, compared lexicographically
  numbers: number[];
};

export const SEMVER_PATTERN = String.raw`^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+(?<build>[0-9A-Za-z.-]+))?$`;
export const CALVER_PATTERN = String.raw`^(?<year>\d{4})\.(?<month>\d{1,2})(?:\.(?<micro>\d+))?$`;

const BUMP_GROUPS = ['major', 'minor', 'patch'] as const;

export function parseVersion(text: string, pattern: string | RegExp): Version | undefined {
  const m = compile(pattern).exec(text);
  if (!m) return undefined;
  const groups: Record<string, string> = {};
  const numbers: number[] = [];
  for (const [name, value] of Object.entries(m.groups ?? {})) {
    if (value === undefined) continue;
    groups[name] = value;
    if (/^\d+$/.test(value)) numbers.push(Number(value));
  }
  return { raw: text, groups, numbers };
}

// the version inside a tag: the tag pattern's version group, or the whole tag when it names none
export function parseTag(tag: string, release: { tagPattern: string; versionPattern: string }): Version | undefined {
  const m = compile(release.tagPattern).exec(tag);
  if (!m) return undefined;
  return parseVersion(m.groups?.['version'] ?? tag, release.versionPattern);
}

export function compareVersions(a: Version, b: Version): number {
  const n = Math.max(a.numbers.length, b.numbers.length);
  for (let i = 0; i < n; i++) {
    const d = (a.numbers[i] ?? -1) - (b.numbers[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

export function isZeroVer(v: Version): boolean {
  return v.groups['major'] === '0';
}

// the version text after a bump: the bumped group raised, the lower ones zeroed, anything past the last of them dropped
// undefined when the pattern has no group for the bump
export function bumpVersion(v: Version, bump: Bump, pattern: string | RegExp): string | undefined {
  if (bump === 'none') return v.raw;
  const m = compile(pattern, 'd').exec(v.raw);
  const spans = m?.indices?.groups;
  if (!spans || !spans[bump]) return undefined;
  const level = BUMP_GROUPS.indexOf(bump);
  const edits = BUMP_GROUPS.flatMap((name, i) => {
    const span = spans[name];
    if (!span) return [];
    const value = i < level ? Number(v.groups[name]) : i === level ? Number(v.groups[name]) + 1 : 0;
    return [{ span, value }];
  });
  // right to left so a widened number does not shift the spans still to be edited
  let out = v.raw;
  for (const { span, value } of [...edits].sort((a, b) => b.span[0] - a.span[0])) {
    out = `${out.slice(0, span[0])}${value}${out.slice(span[1])}`;
  }
  const tail = v.raw.length - Math.max(...edits.map((e) => e.span[1]));
  return out.slice(0, out.length - tail);
}

// which of major, minor or patch moved between two versions; undefined when the versions have none of those groups
export function bumpBetween(from: Version, to: Version): Bump | undefined {
  if (!BUMP_GROUPS.some((g) => from.groups[g] !== undefined)) return undefined;
  for (const g of BUMP_GROUPS) {
    if (from.groups[g] !== to.groups[g]) return g;
  }
  return 'none';
}

function compile(pattern: string | RegExp, flags = ''): RegExp {
  return typeof pattern === 'string' ? new RegExp(pattern, flags) : new RegExp(pattern.source, flags || pattern.flags);
}
