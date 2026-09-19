export type ParsedCommit = {
  sha: string;
  subject: string;
  body: string;
  type?: string;
  scope?: string;
  breaking: boolean;
  conventional: boolean;
  trailers: string[];
};

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;

export function parseCommit(sha: string, message: string): ParsedCommit {
  const [first = '', ...rest] = message.split('\n');
  const body = rest.join('\n').trim();
  const m = HEADER.exec(first.trim());
  const trailers = body
    .split('\n')
    .filter((l) => /^[A-Za-z-]+:\s/.test(l))
    .map((l) => l.split(':')[0]!.trim());
  const breakingFooter = /(^|\n)BREAKING[ -]CHANGE:/.test(body);
  if (!m) return { sha, subject: first, body, breaking: breakingFooter, conventional: false, trailers };
  return {
    sha,
    subject: first,
    body,
    type: m[1],
    scope: m[2],
    breaking: m[3] === '!' || breakingFooter,
    conventional: true,
    trailers,
  };
}

export type Bump = 'major' | 'minor' | 'patch' | 'none';

const BUMP_RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

export function maxBump(a: Bump, b: Bump): Bump {
  return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}

// the bump the commit types alone call for; a breaking change below 1.0.0 requires zeroVerBreaking
export function requiredBump(commits: ParsedCommit[], version?: [number, number, number], zeroVerBreaking: 'major' | 'minor' = 'minor'): Bump {
  let bump: Bump = 'none';
  for (const c of commits) {
    if (c.breaking) bump = maxBump(bump, version && version[0] === 0 ? zeroVerBreaking : 'major');
    else if (c.type === 'feat') bump = maxBump(bump, 'minor');
    else if (c.type === 'fix' || c.type === 'perf') bump = maxBump(bump, 'patch');
  }
  return bump;
}

export function parseSemver(tag: string, prefix = 'v'): [number, number, number] | undefined {
  const raw = tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function bumpVersion(version: [number, number, number], bump: Bump): [number, number, number] {
  const [a, b, c] = version;
  switch (bump) {
    case 'major':
      return [a + 1, 0, 0];
    case 'minor':
      return [a, b + 1, 0];
    case 'patch':
      return [a, b, c + 1];
    case 'none':
      return version;
  }
}

export function bumpBetween(from: [number, number, number], to: [number, number, number]): Bump {
  if (to[0] !== from[0]) return 'major';
  if (to[1] !== from[1]) return 'minor';
  if (to[2] !== from[2]) return 'patch';
  return 'none';
}

// git log with a record separator, one commit per record: sha, then the full message
export function parseLog(raw: string): ParsedCommit[] {
  return raw
    .split('\u001e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const nl = record.indexOf('\n');
      const sha = nl < 0 ? record : record.slice(0, nl);
      const message = nl < 0 ? '' : record.slice(nl + 1);
      return parseCommit(sha.trim(), message);
    });
}

export const LOG_FORMAT = '--format=%x1e%H%n%B';
