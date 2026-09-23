import type { Forge } from '../forge/forge.ts';

// what a grade call's subject string names, parsed before any forge request is made.
// an issue or pull request url carries its own repo, which may differ from the session's
export type ParsedSubject =
  | { kind: 'issue'; number: number; repo?: string }
  | { kind: 'pr'; number: number; repo?: string }
  // base..head in the checkout, the pull request it would open
  | { kind: 'pr'; range: string }
  | { kind: 'commit'; ref: string }
  | { kind: 'release'; proposed?: string }
  | { kind: 'mixed'; subject: MixedSubject }
  | { kind: 'rules'; subject: RulesSubject };

// what a subject that may be a reference or free text turned out to name
export type MixedSubject =
  | { kind: 'issue' | 'pr'; number: number; repo?: string }
  | { kind: 'commit'; ref: string }
  | { kind: 'text'; text: string };

// what the rules are read against: an issue, or free text. a pull request or a commit is a diff, and no diff is judged
export type RulesSubject = { kind: 'issue'; number: number; repo?: string } | { kind: 'text'; text: string };

export type ParsedKind = ParsedSubject['kind'];

const NUMBER = /^#?(\d+)$/;
const COMMIT = /^[0-9a-f]{7,40}$|\.\./;
const URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const RANGE = /^[^\s#-][^\s]*\.\.[^\s]*$/;
const A_NOUN: Record<'issue' | 'pr', string> = { issue: 'an issue', pr: 'a pull request' };

// the forms each kind accepts, as the refusal names them
export function expectedSubject(kind: ParsedKind, forge: Pick<Forge, 'name'>): string {
  switch (kind) {
    case 'issue':
      return `an issue number (N or #N) or a ${forge.name} issue URL`;
    case 'pr':
      return `a pull request number (N or #N), a ${forge.name} pull request URL, or a range (dev..HEAD)`;
    case 'commit':
      return 'a commit ref (a sha, branch or tag) or range (main..HEAD)';
    case 'release':
      return 'a tag or version (v1.4.0), or "release" for the required bump alone';
    case 'mixed':
      return `an issue number (N or #N), a ${forge.name} issue or pull request URL, a commit ref or range, or free text`;
    case 'rules':
      return `an issue number (N or #N), a ${forge.name} issue URL, or free text (in text)`;
  }
}

const shown = (ref: string): string => (ref.length > 60 ? `${ref.slice(0, 57)}...` : ref);

// the refusal of a subject for a pack of the given kind, with the forms it takes named
export function refusal(kind: ParsedKind, ref: string, why: string, forge: Pick<Forge, 'name'>): Error {
  return new Error(`${kind} pack: ${why} (${JSON.stringify(shown(ref))}); expected ${expectedSubject(kind, forge)}`);
}

// parses the subject of a grade call for a pack of the given kind, refusing with the expected forms named.
// repo is the explicit repo of the call, when given; a url naming a different repo is refused.
// a bare number names an issue for the mixed and rules kinds
export function parseSubject<K extends ParsedKind>(kind: K, ref: string | undefined, forge: Pick<Forge, 'name' | 'parseUrl'>, repo?: string): Extract<ParsedSubject, { kind: K }>;
export function parseSubject(kind: ParsedKind, ref: string | undefined, forge: Pick<Forge, 'name' | 'parseUrl'>, repo?: string): ParsedSubject {
  const raw = (ref ?? '').trim();
  if (!raw) throw new Error(`${kind} pack: no subject; expected ${expectedSubject(kind, forge)}`);
  const refuse = (why: string): never => {
    throw refusal(kind, raw, why, forge);
  };
  const link = forge.parseUrl(raw);
  // an issue or pull request by number or url; the two kinds share the forms, only the kind differs
  const numbered = (kind: 'issue' | 'pr'): { number: number; repo?: string } => {
    const n = NUMBER.exec(raw);
    if (n) return { number: Number(n[1]) };
    if (link) {
      if (link.kind !== kind) return refuse(`subject is ${A_NOUN[link.kind]} URL, not ${A_NOUN[kind]}`);
      if (repo !== undefined && repo !== link.repo) return refuse(`subject URL names ${link.repo} but repo is ${repo}`);
      return { number: link.number, repo: link.repo };
    }
    if (URL.test(raw)) return refuse(`subject is a URL ${forge.name} does not serve as ${A_NOUN[kind]}`);
    return refuse(/\s/.test(raw) ? 'subject reads as text, not a reference' : 'subject is not a number');
  };
  switch (kind) {
    case 'issue':
      return { kind, ...numbered(kind) };
    case 'pr':
      return RANGE.test(raw) ? { kind, range: raw } : { kind, ...numbered(kind) };
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
    case 'mixed': {
      const n = NUMBER.exec(raw);
      if (n) return { kind, subject: { kind: 'issue', number: Number(n[1]) } };
      if (link) {
        if (repo !== undefined && repo !== link.repo) return refuse(`subject URL names ${link.repo} but repo is ${repo}`);
        return { kind, subject: { kind: link.kind, number: link.number, repo: link.repo } };
      }
      if (URL.test(raw)) return refuse(`subject is a URL ${forge.name} does not serve as an issue or a pull request`);
      if (COMMIT.test(raw)) return { kind, subject: { kind: 'commit', ref: raw } };
      return { kind, subject: { kind: 'text', text: raw } };
    }
    case 'rules': {
      if (link?.kind === 'pr') return refuse('subject is a pull request URL, and a pull request is not read against the rules');
      if (link || NUMBER.test(raw)) return { kind, subject: { kind: 'issue', ...numbered('issue') } };
      if (URL.test(raw)) return refuse(`subject is a URL ${forge.name} does not serve as an issue`);
      if (COMMIT.test(raw)) return refuse('subject is a commit ref or range, and a commit is not read against the rules');
      return { kind, subject: { kind: 'text', text: raw } };
    }
  }
}
