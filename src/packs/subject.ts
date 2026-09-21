import type { Forge } from '../forge/forge.ts';

// what a grade call's subject string names, parsed before any forge request is made.
// an issue or pull request url carries its own repo, which may differ from the session's
export type ParsedSubject =
  | { kind: 'issue'; number: number; repo?: string }
  | { kind: 'pr'; number: number; repo?: string }
  | { kind: 'commit'; ref: string }
  | { kind: 'release'; proposed?: string };

export type ParsedKind = ParsedSubject['kind'];

const NUMBER = /^#?(\d+)$/;
const URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const NOUN: Record<'issue' | 'pr', string> = { issue: 'issue', pr: 'pull request' };
const A_NOUN: Record<'issue' | 'pr', string> = { issue: 'an issue', pr: 'a pull request' };

// the forms each kind accepts, as the refusal names them
export function expectedSubject(kind: ParsedKind, forge: Pick<Forge, 'name'>): string {
  switch (kind) {
    case 'issue':
    case 'pr':
      return `${A_NOUN[kind]} number (N or #N) or a ${forge.name} ${NOUN[kind]} URL`;
    case 'commit':
      return 'a commit ref (a sha, branch or tag) or range (main..HEAD)';
    case 'release':
      return 'a tag or version (v1.4.0), or "release" for the required bump alone';
  }
}

const shown = (ref: string): string => (ref.length > 60 ? `${ref.slice(0, 57)}...` : ref);

// parses the subject of a grade call for a pack of the given kind, refusing with the expected forms named.
// repo is the explicit repo of the call, when given; a url naming a different repo is refused
export function parseSubject<K extends ParsedKind>(kind: K, ref: string | undefined, forge: Pick<Forge, 'name' | 'parseUrl'>, repo?: string): Extract<ParsedSubject, { kind: K }>;
export function parseSubject(kind: ParsedKind, ref: string | undefined, forge: Pick<Forge, 'name' | 'parseUrl'>, repo?: string): ParsedSubject {
  const raw = (ref ?? '').trim();
  const expected = expectedSubject(kind, forge);
  if (!raw) throw new Error(`${kind} pack: no subject; expected ${expected}`);
  const refuse = (why: string): never => {
    throw new Error(`${kind} pack: ${why} (${JSON.stringify(shown(raw))}); expected ${expected}`);
  };
  const link = forge.parseUrl(raw);
  switch (kind) {
    case 'issue':
    case 'pr': {
      const n = NUMBER.exec(raw);
      if (n) return { kind, number: Number(n[1]) };
      if (link) {
        if (link.kind !== kind) return refuse(`subject is ${A_NOUN[link.kind]} URL, not ${A_NOUN[kind]}`);
        if (repo !== undefined && repo !== link.repo) return refuse(`subject URL names ${link.repo} but repo is ${repo}`);
        return { kind, number: link.number, repo: link.repo };
      }
      if (URL.test(raw)) return refuse(`subject is a URL ${forge.name} does not serve as ${A_NOUN[kind]}`);
      return refuse(/\s/.test(raw) ? 'subject reads as text, not a reference' : 'subject is not a number');
    }
    case 'commit': {
      if (link || URL.test(raw)) return refuse('subject is a URL');
      if (raw.startsWith('#')) return refuse('subject is an issue number, not a ref');
      if (/\s/.test(raw)) return refuse('subject reads as text, not a reference');
      if (raw.startsWith('-')) return refuse('subject starts with a dash');
      return { kind, ref: raw };
    }
    case 'release': {
      if (raw === 'release') return { kind };
      if (link || URL.test(raw)) return refuse('subject is a URL');
      if (raw.startsWith('#')) return refuse('subject is an issue number, not a version');
      if (/\s/.test(raw)) return refuse('subject reads as text, not a tag');
      return { kind, proposed: raw };
    }
  }
}
