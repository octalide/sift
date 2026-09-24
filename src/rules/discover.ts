import type { Forge } from '../forge/forge.ts';
import type { Git } from '../forge/git.ts';
import type { RepoConfig } from '../repo/config.ts';
import { digest } from '../hash.ts';
import { rulesKeys } from '../keys.ts';
import { bandOf } from '../judge/bands.ts';
import { rank } from '../judge/rank.ts';
import { DEFAULT_THRESHOLDS, failureText, type Judge, type Questions } from '../judge/types.ts';
import { excerptOf } from '../locate/tree.ts';
import type { StoreLike } from '../log.ts';
import { pool } from '../pool.ts';
import { truncate } from '../tokens.ts';
import { ruleParagraphs } from './paragraphs.ts';

// what a rule governs, asked once at discovery. text: whether anything a contribution's text says can follow or break
// it, false for a rule about labels, milestones, assignees or other metadata set beside the text
export type RuleScope = { text: boolean };

export type Rule = { source: string; text: string; scope: RuleScope };

// what a subject the rules read carries: metadata when it is an artifact read with its labels and milestone, not when
// it is text about to be written, which sets none
export type RuleTarget = { metadata: boolean };

// whether a rule governs a subject: the one place a rule's scope is matched to what the subject carries
export function governs(rule: Rule, target: RuleTarget): boolean {
  return rule.scope.text || target.metadata;
}

// a file a source lists: its path, and when the source has one, an id that changes whenever the content does
export type SourceFile = { path: string; id?: string };

// where rule documents are read from: a checkout, or a repository on the forge
export type RuleSource = {
  // names the cache entry: the checkout root, or the repository and ref
  scope: string;
  // every file in the repository; a file with an id keys the cache without being read
  list: () => Promise<SourceFile[]>;
  // a file's text, undefined when absent
  read: (path: string) => Promise<string | undefined>;
  // whether a path is an issue or pull request template, at a location the forge documents
  template: (path: string) => boolean;
  // a file in another repository, for owner/repo:path@ref entries; undefined without a forge
  remote: (repo: string, path: string, ref?: string) => Promise<string | undefined>;
};

export type Discovery = {
  // the documents the rules came from, in order
  docs: string[];
  rules: Rule[];
  // how many paths were candidates, and every document whose paragraphs were read: listed, contributing guide, or kept by the judge
  candidates: number;
  kept: string[];
  cached: boolean;
  // the judge failed, nothing was cached
  error?: string;
  // the discovery outlasted the wait and keeps running, for the next call on the scope to join or read from the cache
  pending?: string;
};

// what the store holds per scope; bump when the shape, the key, the questions or the keep policy change
const VERSION = 6;
type Cached = { version: number; key: string; docs: string[]; rules: Rule[]; candidates: number; kept: string[] };

export const PROSE = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'org']);
// directories whose prose is a candidate at any depth; the root is a candidate at depth zero
const PROSE_DIRS = new Set(['docs', '.github']);
const EXCERPT = { lines: 12, width: 160 };
// the headings shown beside the excerpt, so a document whose opening is narrative still shows its sections
const OUTLINE = { headings: 40, width: 80 };
// the contributing guide by name, at a candidate location: rules for contributors by definition, kept without a judgement
const CONTRIBUTING = /^contributing(\.[^/]+)?$/i;

export const DOC_QUESTION: Questions = {
  rules: {
    type: 'noul',
    instructions: 'The document {path} states rules contributors to this repository must follow.',
    criteria: {
      true: 'Its text tells contributors what they must or must not do: conventions, style, process, review or commit requirements.',
      false: 'It describes, explains or records: a readme, a tutorial, a changelog, an api reference, a design note, a template with only headings.',
    },
  },
};

// a rule directs contributors; a description of what the repository's software does is not one, since a change may alter it.
// a paragraph is read beside its document, since a reference's "requires" reads as a rule on its own
export const PARAGRAPH_QUESTION: Questions = {
  rule: {
    type: 'noul',
    instructions: 'Read as part of the document in the state, this paragraph directs contributors, a rule a contribution can break, not a description of what the software does: {text}',
    criteria: {
      true: 'It tells a contributor what a change, a commit, a branch, an issue, a pull request or a message must or must not do: a convention, a requirement, a prohibition, a review or release process, or the form another project requires of code here (a migration guide\'s old and new forms).',
      false: 'It describes what this repository\'s software does, offers, accepts or refuses (a feature, a command, an option, a config field a user sets for their own repository, a pack, a check), even in words like may, must or is refused, since a contribution may change that behaviour; or it says what the project\'s maintainers or community leaders do, pledge or will do in response (enforcement, consequences, responsibilities); or it explains, introduces, records history or gives setup, build or test steps to run: nothing a contribution could comply with or violate.',
    },
  },
  // what the rule governs: a label convention is kept as a rule, but no text can break it
  text: {
    type: 'noul',
    instructions: 'Read as part of the document in the state, what a contribution\'s text says (a title, a body, a commit message, a comment) can follow or break this paragraph: {text}',
    criteria: {
      true: 'The paragraph asks something of the words written: their form, wording, prefixes, sections, what they state, name or link.',
      false: 'The paragraph asks only for metadata set beside the text: labels, milestones, assignees, reviewers, projects or other sidebar fields. Nothing the text says can follow or break it.',
    },
  },
};

// a candidate is prose at the root, or prose under docs/ or .github/ at any depth
export function candidate(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1]!;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || !PROSE.has(name.slice(dot + 1).toLowerCase())) return false;
  return parts.length === 1 || PROSE_DIRS.has(parts[0]!.toLowerCase());
}

export function contributingGuide(path: string): boolean {
  return candidate(path) && CONTRIBUTING.test(path.slice(path.lastIndexOf('/') + 1));
}

// the document's markdown headings in order, outside code blocks
export function outlineOf(text: string): string[] {
  const out: string[] = [];
  let inCode = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) inCode = !inCode;
    const h = inCode ? null : /^#{1,6}\s+(.+)$/.exec(line);
    if (!h) continue;
    const t = h[1]!.trim();
    out.push(truncate(t, OUTLINE.width));
    if (out.length >= OUTLINE.headings) break;
  }
  return out;
}

// an exclude entry is a path or a glob: * within one segment, ** across segments
export function excluded(path: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (!p.includes('*')) return p === path;
    const re = p
      .split('**')
      .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
      .join('.*');
    return new RegExp(`^${re}$`).test(path);
  });
}

// a rules.docs entry: a path in the source, or owner/repo:path[@ref] read from the forge
export async function ruleDoc(doc: string, source: Pick<RuleSource, 'read' | 'remote'>): Promise<string | undefined> {
  const remote = /^((?:[\w.-]+\/)+[\w.-]+):([^@]+?)(?:@(.+))?$/.exec(doc);
  if (!remote) return source.read(doc);
  const [, repo, path, ref] = remote;
  return source.remote(repo!, path!, ref);
}

type Doc = { path: string; text: string };

// the candidates ranked and every one the judge does not rule out kept, the listed documents and the contributing guide
// added as they are, every kept document's paragraphs ranked to rules. the result is cached under the source's scope keyed
// by every candidate's content (its id where the source lists one, else a digest of its text) and the config, so a
// cached discovery reads no candidate the source ids and the judge runs only on a change. a discovery with any judge
// failure is never cached, so the next one asks again. every discovery that answers from or writes the cache marks it
// read at now, so a cache no discovery reads goes stale and is swept. a fresh discovery or a failure logs one line
// naming what was kept
export async function discoverRules(source: RuleSource, config: RepoConfig['rules'], judge: Judge, store: StoreLike, now: () => number, log: (text: string) => void): Promise<Discovery> {
  const listed = new Set(config.docs);
  const files = (await source.list()).filter((f) => (candidate(f.path) || source.template(f.path)) && !listed.has(f.path) && !excluded(f.path, config.exclude)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // a file without an id is read to key the cache, and that read is kept for the discovery
  const unkeyed = await pool(files.filter((f) => f.id === undefined), 16, async (f) => ({ path: f.path, text: await source.read(f.path) }));
  const texts = new Map(unkeyed.map((d) => [d.path, d.text]));
  const present = files.filter((f) => f.id !== undefined || texts.get(f.path) !== undefined);
  const explicit: Doc[] = [];
  for (const doc of config.docs) {
    const text = await ruleDoc(doc, source);
    if (text !== undefined) explicit.push({ path: doc, text });
  }
  const versions = present.map((f) => [f.path, f.id !== undefined ? `id:${f.id}` : digest(texts.get(f.path)!)]);
  const key = digest(JSON.stringify({ v: VERSION, explicit: explicit.map((d) => [d.path, digest(d.text)]), files: versions, exclude: config.exclude }));
  const keys = rulesKeys(source.scope);
  const cached = (await store.get(keys.cache)) as Cached | undefined;
  if (cached && cached.version === VERSION && cached.key === key) {
    await store.set(keys.seen, now());
    return { docs: cached.docs, rules: cached.rules, candidates: cached.candidates, kept: cached.kept, cached: true };
  }
  const read = await pool(present, 16, async (f) => ({ path: f.path, text: texts.has(f.path) ? texts.get(f.path) : await source.read(f.path) }));
  // a listed file that cannot be read would be cached as if it were not there
  const unread = read.filter((d) => d.text === undefined).map((d) => d.path);
  const candidates: Doc[] = read.filter((d): d is Doc => d.text !== undefined);
  const failed = (kept: Doc[], error: string): Discovery => {
    log(`sift rules ${source.scope}: discovery failed, nothing cached (${error})`);
    return { docs: [], rules: [], candidates: candidates.length, kept: kept.map((d) => d.path), cached: false, error };
  };
  if (unread.length > 0) return failed([], `unreadable: ${unread.join(', ')}`);
  const guides = candidates.filter((d) => contributingGuide(d.path));
  const judged = candidates.filter((d) => !contributingGuide(d.path));
  const kept: Doc[] = [...explicit, ...guides];
  if (judged.length > 0) {
    const items = judged.map((d) => ({ path: d.path, excerpt: excerptOf(d.text, EXCERPT.lines, EXCERPT.width), headings: outlineOf(d.text) }));
    const ranked = await rank(items, DOC_QUESTION, judge, { mode: 'batched' });
    if (!ranked.ok) return failed(kept, failureText(ranked));
    const unanswered = ranked.items.filter((r) => r.answers['rules'] === undefined);
    if (unanswered.length > 0) return failed(kept, `malformed: no answer for ${unanswered.map((r) => judged[r.index]!.path).join(', ')}`);
    for (const r of ranked.items) if (bandOf(r.answers['rules']!, DEFAULT_THRESHOLDS) !== 'violated') kept.push(judged[r.index]!);
  }
  // each document's paragraphs are ranked against that document, its opening and outline in the state
  const ranks = await pool(kept, 4, async (d) => {
    const paragraphs = ruleParagraphs(d.text);
    if (paragraphs.length === 0) return { doc: d, paragraphs, ranked: undefined };
    const context = { document: { path: d.path, excerpt: excerptOf(d.text, EXCERPT.lines, EXCERPT.width), headings: outlineOf(d.text) } };
    return { doc: d, paragraphs, ranked: await rank(paragraphs, PARAGRAPH_QUESTION, judge, { mode: 'batched', context, concurrency: 2 }) };
  });
  const rules: Rule[] = [];
  for (const { doc, paragraphs, ranked } of ranks) {
    if (!ranked) continue;
    if (!ranked.ok) return failed(kept, failureText(ranked));
    const unanswered = ranked.items.filter((r) => r.answers['rule'] === undefined || r.answers['text'] === undefined);
    if (unanswered.length > 0) return failed(kept, `malformed: no answer for ${unanswered.length} of ${paragraphs.length} paragraphs in ${doc.path}`);
    // a rule governs text unless the judge rules text out: an unclear one is still judged against it
    for (const r of ranked.items) {
      if (bandOf(r.answers['rule']!, DEFAULT_THRESHOLDS) !== 'satisfied') continue;
      const text = bandOf(r.answers['text']!, DEFAULT_THRESHOLDS) !== 'violated';
      rules.push({ source: doc.path, text: paragraphs[r.index]!, scope: { text } });
    }
  }
  const docs = kept.map((d) => d.path).filter((p) => rules.some((r) => r.source === p));
  const result: Cached = { version: VERSION, key, docs, rules, candidates: candidates.length, kept: kept.map((d) => d.path) };
  await store.set(keys.cache, result);
  await store.set(keys.seen, now());
  log(`sift rules ${source.scope}: ${result.candidates} candidate${result.candidates === 1 ? '' : 's'}, kept ${result.kept.join(', ') || 'none'}; ${rules.length} rule${rules.length === 1 ? '' : 's'}${docs.length > 0 ? ` from ${docs.join(', ')}` : ''}`);
  return { docs, rules, candidates: result.candidates, kept: result.kept, cached: false };
}

// how long a call waits for its discovery: well inside the engine's 10 s cap on a hook, with room for the judgement and
// the write the call makes once the rules are known
export const DISCOVERY_WAIT_MS = 5_000;

export type DiscoveriesHost = {
  judge: Judge;
  store: StoreLike;
  now: () => number;
  // the session log a fresh discovery names what it kept in
  log: (text: string) => void;
  schedule: (ms: number, fn: () => void) => { cancel: () => void };
  waitMs: number;
};

// the discoveries in flight, one per scope and rules config. a call waits for its own up to the wait; one that outlasts
// it answers pending while the discovery runs on, so the next call joins it or reads what it cached, and no single call
// carries a whole cold discovery
export class Discoveries {
  private readonly running = new Map<string, Promise<Discovery>>();

  constructor(private readonly host: DiscoveriesHost) {}

  async discover(source: RuleSource, config: RepoConfig['rules']): Promise<Discovery> {
    const { judge, store, now, log, schedule, waitMs } = this.host;
    const key = JSON.stringify([source.scope, config.docs, config.exclude]);
    let task = this.running.get(key);
    if (!task) {
      task = discoverRules(source, config, judge, store, now, log).finally(() => this.running.delete(key));
      this.running.set(key, task);
      // a throw still reaches every call waiting on it; one no call waits for any more is not an unhandled rejection
      task.catch(() => {});
    }
    let timer: { cancel: () => void } | undefined;
    const late = new Promise<Discovery>((resolve) => {
      timer = schedule(waitMs, () =>
        resolve({ docs: [], rules: [], candidates: 0, kept: [], cached: false, pending: `rule discovery for ${source.scope} outlasted its ${waitMs / 1000} s wait and keeps running; the next call on it reuses what it finds` }),
      );
    });
    try {
      return await Promise.race([task, late]);
    } finally {
      timer?.cancel();
    }
  }
}

// the checkout: tracked paths from git, text from the working tree. templates are the tracked paths at the
// locations the bound forge documents, read from the tree: the forge itself is never asked for them
export function checkoutSource(root: string, git: Git, fs: { read: (path: string) => Promise<string>; exists: (path: string) => Promise<boolean> }, forge?: Forge): RuleSource {
  return {
    scope: root,
    // the working tree is what is read, so no path carries the index's id
    list: async () => (await git(['ls-files', '-z'])).split('\0').filter(Boolean).map((path) => ({ path })),
    read: async (path) => ((await fs.exists(`${root}/${path}`)) ? fs.read(`${root}/${path}`) : undefined),
    template: (path) => forge?.template(path) !== undefined,
    remote: (r, path, ref) => (forge ? forge.file(r, path, ref) : Promise.resolve(undefined)),
  };
}

// a repository on the forge at a ref, the default branch when unset: one tree listing keys the cache, and the
// candidates are read only when it misses
export function forgeSource(forge: Forge, repo: string, ref?: string): RuleSource {
  return {
    scope: ref === undefined ? repo : `${repo}@${ref}`,
    list: () => forge.contents(repo, ref),
    read: (path) => forge.file(repo, path, ref),
    template: (path) => forge.template(path) !== undefined,
    remote: (r, path, at) => forge.file(r, path, at),
  };
}
