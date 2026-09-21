import { isZeroVer, type Version } from './version.ts';

export type RawCommit = { sha: string; message: string };

export type ParsedCommit = {
  sha: string;
  subject: string;
  body: string;
  // the format's named groups, present when the format names them and the subject matched
  type?: string;
  scope?: string;
  description?: string;
  breaking: boolean;
  // the subject line matched the commit format
  matched: boolean;
  trailers: string[];
};

// the conventional commits header: type, an optional scope, an optional breaking mark, then the description
export const CONVENTIONAL_FORMAT = String.raw`^(?<type>\w+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s+(?<description>.+)$`;

export function parseCommit(sha: string, message: string, format: string | RegExp = CONVENTIONAL_FORMAT): ParsedCommit {
  const [first = '', ...rest] = message.split('\n');
  const body = rest.join('\n').trim();
  const m = (typeof format === 'string' ? new RegExp(format) : format).exec(first.trim());
  const trailers = body
    .split('\n')
    .filter((l) => /^[A-Za-z-]+:\s/.test(l))
    .map((l) => l.split(':')[0]!.trim());
  const breakingFooter = /(^|\n)BREAKING[ -]CHANGE:/.test(body);
  if (!m) return { sha, subject: first, body, breaking: breakingFooter, matched: false, trailers };
  const g = m.groups ?? {};
  return {
    sha,
    subject: first,
    body,
    type: g['type'],
    scope: g['scope'],
    description: g['description'],
    breaking: Boolean(g['breaking']) || breakingFooter,
    matched: true,
    trailers,
  };
}

// the header a scope pattern is matched against: type(scope), or the bare type without one
export function scopeHeader(c: ParsedCommit): string {
  return c.scope === undefined ? (c.type ?? '') : `${c.type ?? ''}(${c.scope})`;
}

export type Bump = 'major' | 'minor' | 'patch' | 'none';

export const BUMPS: readonly Bump[] = ['major', 'minor', 'patch', 'none'];

// the bump each conventional commit type calls for; a type not listed calls for none
export const CONVENTIONAL_BUMPS: Record<string, Bump> = { feat: 'minor', fix: 'patch', perf: 'patch' };

const BUMP_RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

export function maxBump(a: Bump, b: Bump): Bump {
  return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}

// the bump the commits alone call for: each type's entry in bumps, a breaking change the breaking bump regardless of
// type, which below 1.0.0 is zeroVerBreaking
export function requiredBump(commits: ParsedCommit[], bumps: Record<string, Bump>, version?: Version, zeroVerBreaking: 'major' | 'minor' = 'minor'): Bump {
  let bump: Bump = 'none';
  for (const c of commits) {
    if (c.breaking) bump = maxBump(bump, version && isZeroVer(version) ? zeroVerBreaking : 'major');
    else if (c.type !== undefined) bump = maxBump(bump, bumps[c.type] ?? 'none');
  }
  return bump;
}

// git log with a record separator, one commit per record: sha, then the full message
export function splitLog(raw: string): RawCommit[] {
  return raw
    .split('\u001e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const nl = record.indexOf('\n');
      const sha = nl < 0 ? record : record.slice(0, nl);
      const message = nl < 0 ? '' : record.slice(nl + 1);
      return { sha: sha.trim(), message };
    });
}

export function parseLog(raw: string, format?: string | RegExp): ParsedCommit[] {
  return splitLog(raw).map((c) => parseCommit(c.sha, c.message, format));
}

export const LOG_FORMAT = '--format=%x1e%H%n%B';
