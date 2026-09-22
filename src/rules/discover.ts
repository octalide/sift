import type { Forge } from '../forge/forge.ts';
import type { Git } from '../forge/git.ts';
import type { RepoConfig } from '../repo/config.ts';
import { digest } from '../hash.ts';
import { bandOf } from '../judge/bands.ts';
import { rank } from '../judge/rank.ts';
import { DEFAULT_THRESHOLDS, failureText, type Judge, type Questions } from '../judge/types.ts';
import { excerptOf } from '../locate/tree.ts';
import type { StoreLike } from '../log.ts';
import { pool } from '../pool.ts';
import { ruleParagraphs } from './paragraphs.ts';

export type Rule = { source: string; text: string };

// where rule documents are read from: a checkout, or a repository on the forge
export type RuleSource = {
  // names the cache entry: the checkout root, or the repository and ref
  scope: string;
  // every file path in the repository
  list: () => Promise<string[]>;
  // a file's text, undefined when absent
  read: (path: string) => Promise<string | undefined>;
  // the forge's issue and pull request templates, by path
  templates: () => Promise<{ path: string; text: string }[]>;
  // a file in another repository, for owner/repo:path@ref entries; undefined without a forge
  remote: (repo: string, path: string, ref?: string) => Promise<string | undefined>;
};

export type Discovery = {
  // the documents the rules came from, in order
  docs: string[];
  rules: Rule[];
  // paths ranked as candidates and how many of them the judge kept
  candidates: number;
  kept: number;
  cached: boolean;
  // the judge failed, nothing was cached
  error?: string;
};

// what the store holds per scope; bump when the shape or the questions change
const VERSION = 1;
type Cached = { version: number; key: string; docs: string[]; rules: Rule[]; candidates: number; kept: number };

export const PROSE = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'org']);
// directories whose prose is a candidate at any depth; the root is a candidate at depth zero
const PROSE_DIRS = new Set(['docs', '.github']);
const EXCERPT = { lines: 12, width: 160 };

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

export const PARAGRAPH_QUESTION: Questions = {
  rule: {
    type: 'noul',
    instructions: 'This paragraph is a rule a contribution can break, not narrative or instruction: {text}',
    criteria: {
      true: 'It requires, forbids or constrains something a change, a commit, a branch, an issue, a pull request or a message could get wrong.',
      false: 'It explains, introduces, describes how something works, or gives steps to run: nothing a contribution could comply with or violate.',
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

// the candidates ranked, the listed documents added as they are, every kept document's paragraphs ranked to rules.
// the result is cached under the source's scope keyed by every file read and the config, so the judge runs only on a change
export async function discoverRules(source: RuleSource, config: RepoConfig['rules'], judge: Judge, store: StoreLike): Promise<Discovery> {
  const listed = new Set(config.docs);
  const paths = (await source.list()).filter((p) => candidate(p) && !listed.has(p) && !excluded(p, config.exclude)).sort();
  const read = await pool(paths, 16, async (path) => ({ path, text: await source.read(path) }));
  const candidates: Doc[] = read.filter((d): d is Doc => d.text !== undefined);
  for (const t of await source.templates()) {
    if (listed.has(t.path) || excluded(t.path, config.exclude) || candidates.some((c) => c.path === t.path)) continue;
    candidates.push({ path: t.path, text: t.text });
  }
  const explicit: Doc[] = [];
  for (const doc of config.docs) {
    const text = await ruleDoc(doc, source);
    if (text !== undefined) explicit.push({ path: doc, text });
  }
  const key = digest(JSON.stringify({ v: VERSION, docs: [...explicit, ...candidates].map((d) => [d.path, digest(d.text)]), exclude: config.exclude }));
  const storeKey = `rules:${source.scope}`;
  const cached = (await store.get(storeKey)) as Cached | undefined;
  if (cached && cached.version === VERSION && cached.key === key) {
    return { docs: cached.docs, rules: cached.rules, candidates: cached.candidates, kept: cached.kept, cached: true };
  }
  const kept: Doc[] = [...explicit];
  if (candidates.length > 0) {
    const ranked = await rank(candidates.map((d) => ({ path: d.path, excerpt: excerptOf(d.text, EXCERPT.lines, EXCERPT.width) })), DOC_QUESTION, judge, { mode: 'batched' });
    if (!ranked.ok) return { docs: [], rules: [], candidates: candidates.length, kept: 0, cached: false, error: failureText(ranked) };
    for (const r of ranked.items) if (bandOf(r.answers['rules']!, DEFAULT_THRESHOLDS) === 'satisfied') kept.push(candidates[r.index]!);
  }
  const paragraphs = kept.flatMap((d) => ruleParagraphs(d.text).map((text) => ({ doc: d.path, text })));
  const rules: Rule[] = [];
  if (paragraphs.length > 0) {
    const ranked = await rank(paragraphs, PARAGRAPH_QUESTION, judge, { mode: 'batched', fields: ['doc'] });
    if (!ranked.ok) return { docs: [], rules: [], candidates: candidates.length, kept: kept.length - explicit.length, cached: false, error: failureText(ranked) };
    for (const r of ranked.items) if (bandOf(r.answers['rule']!, DEFAULT_THRESHOLDS) === 'satisfied') rules.push({ source: paragraphs[r.index]!.doc, text: paragraphs[r.index]!.text });
  }
  const docs = kept.map((d) => d.path).filter((p) => rules.some((r) => r.source === p));
  const result: Cached = { version: VERSION, key, docs, rules, candidates: candidates.length, kept: kept.length - explicit.length };
  await store.set(storeKey, result);
  return { docs, rules, candidates: result.candidates, kept: result.kept, cached: false };
}

// the checkout: tracked paths from git, text from the working tree. templates are the tracked paths at the
// locations the bound forge documents, read from the tree: the forge itself is never asked for them
export function checkoutSource(root: string, git: Git, fs: { read: (path: string) => Promise<string>; exists: (path: string) => Promise<boolean> }, forge?: Forge): RuleSource {
  const list = async () => (await git(['ls-files', '-z'])).split('\0').filter(Boolean);
  const read = async (path: string) => ((await fs.exists(`${root}/${path}`)) ? fs.read(`${root}/${path}`) : undefined);
  return {
    scope: root,
    list,
    read,
    templates: async () => {
      if (!forge) return [];
      const paths = (await list()).filter((p) => forge.template(p) !== undefined);
      const docs = await pool(paths, 16, async (path) => ({ path, text: await read(path) }));
      return docs.filter((d): d is Doc => d.text !== undefined);
    },
    remote: (r, path, ref) => (forge ? forge.file(r, path, ref) : Promise.resolve(undefined)),
  };
}

// a repository on the forge at a ref, the default branch when unset
export function forgeSource(forge: Forge, repo: string, ref?: string): RuleSource {
  return {
    scope: `${repo}@${ref ?? ''}`,
    list: () => forge.contents(repo, ref),
    read: (path) => forge.file(repo, path, ref),
    templates: async () => (await forge.templates(repo)).map((t) => ({ path: t.name, text: t.body })),
    remote: (r, path, at) => forge.file(r, path, at),
  };
}
