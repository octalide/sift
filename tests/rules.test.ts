import { describe, expect, it, vi } from 'vitest';
import { templateKind } from '../src/forge/github.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/github/config.ts';
import { rulesSubject } from '../src/github/subjects.ts';
import type { Judge } from '../src/judge/types.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { runPack } from '../src/packs/run.ts';
import { candidate, checkoutSource, discoverRules, excluded, forgeSource, ruleDoc } from '../src/rules/discover.ts';
import { ruleParagraphs } from '../src/rules/paragraphs.ts';
import { fakeForge } from './fake-forge.ts';
import { memorySource, memoryStore, yesJudge } from './fake-source.ts';

const rules = (over: Partial<typeof DEFAULT_CONFIG.rules> = {}) => ({ ...DEFAULT_CONFIG.rules, ...over });

// answers the document question by path and the paragraph question by text
function judgeBy(docs: (path: string) => number, paragraphs: (text: string) => number, asked: { state: unknown; instructions: string[] }[] = []): Judge {
  return {
    name: 'fake',
    ask: async (state, q) => {
      asked.push({ state, instructions: Object.values(q).map((x) => x.instructions) });
      const answers = Object.fromEntries(
        Object.entries(q).map(([k, x]) => {
          const doc = /^The document (.+) states rules/.exec(x.instructions);
          const p = doc ? docs(doc[1]!) : paragraphs(x.instructions.replace(/^.*not narrative or instruction: /, ''));
          return [k, { type: 'noul' as const, p }];
        }),
      );
      return { ok: true, backend: 'fake', latencyMs: 1, answers };
    },
  };
}

describe('rule document candidates', () => {
  it('takes prose at the root and under docs/ or .github/ at any depth', () => {
    for (const p of ['README.md', 'CONTRIBUTING.txt', 'notes.rst', 'docs/guide.md', 'docs/a/b/c.org', '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug.md', 'Docs/x.MD']) expect(candidate(p), p).toBe(true);
    for (const p of ['src/index.ts', 'src/README.md', 'LICENSE', '.github/workflows/ci.yml', 'docs/img.png', '.md', 'package.json']) expect(candidate(p), p).toBe(false);
  });

  it('excludes by path or glob', () => {
    expect(excluded('README.md', ['README.md'])).toBe(true);
    expect(excluded('README.md', ['readme.md'])).toBe(false);
    expect(excluded('docs/a/b.md', ['docs/*'])).toBe(false);
    expect(excluded('docs/a/b.md', ['docs/**'])).toBe(true);
    expect(excluded('docs/b.md', ['docs/*.md'])).toBe(true);
    expect(excluded('CHANGELOG.md', ['*.md'])).toBe(true);
    expect(excluded('CHANGELOG.md', [])).toBe(false);
  });

  it('reads a listed doc from the source or from another repository by repo:path@ref', async () => {
    const source = memorySource({ 'CONTRIBUTING.md': '# local' }, { remote: { 'briar-systems/mach-std:MIGRATION.md@v6.0.0': '# at tag', 'o/r:doc/RULES.md@undefined': '# default', 'group/sub/project:RULES.md@undefined': '# nested' } });
    expect(await ruleDoc('CONTRIBUTING.md', source)).toBe('# local');
    expect(await ruleDoc('MISSING.md', source)).toBeUndefined();
    expect(await ruleDoc('briar-systems/mach-std:MIGRATION.md@v6.0.0', source)).toBe('# at tag');
    expect(await ruleDoc('o/r:doc/RULES.md', source)).toBe('# default');
    expect(await ruleDoc('group/sub/project:RULES.md', source)).toBe('# nested');
  });
});

describe('rule discovery', () => {
  const files = {
    'README.md': '# sift\n\nA plugin that judges things.\n\nInstall it with npm.\n',
    'CONTRIBUTING.md': '# Contributing\n\nThanks for helping out.\n\n- Conventional commits, the issue number as the scope.\n- No em dashes anywhere.\n',
    'docs/design/notes.md': '# Notes\n\nThe watcher polls conditionally.\n',
    'src/README.md': '# src\n\nNever a candidate.\n',
    '.github/PULL_REQUEST_TEMPLATE.md': '## Summary\n\n## Testing\n',
  };
  const isRuleDoc = (p: string) => (p === 'CONTRIBUTING.md' ? 0.9 : 0.1);
  const isRule = (t: string) => (/commits|em dashes|must/.test(t) ? 0.9 : 0.2);

  it('ranks the candidates, then the paragraphs of the kept documents, and names the documents used', async () => {
    const asked: { state: unknown; instructions: string[] }[] = [];
    const store = memoryStore();
    const found = await discoverRules(memorySource(files), rules(), judgeBy(isRuleDoc, isRule, asked), store);
    expect(found).toEqual({
      docs: ['CONTRIBUTING.md'],
      rules: [
        { source: 'CONTRIBUTING.md', text: 'Contributing: Conventional commits, the issue number as the scope.' },
        { source: 'CONTRIBUTING.md', text: 'Contributing: No em dashes anywhere.' },
      ],
      candidates: 4,
      kept: 1,
      cached: false,
    });
    // one batched request per rank: the documents with a path and an excerpt, then the paragraphs of the kept one alone
    expect(asked).toHaveLength(2);
    const docs = (asked[0]!.state as { items: { k: number; path: string; excerpt: string }[] }).items;
    expect(docs.map((d) => d.path)).toEqual(['.github/PULL_REQUEST_TEMPLATE.md', 'CONTRIBUTING.md', 'README.md', 'docs/design/notes.md']);
    expect(docs[1]!.excerpt).toBe('# Contributing\nThanks for helping out.\n- Conventional commits, the issue number as the scope.\n- No em dashes anywhere.');
    expect(asked[0]!.instructions[1]).toBe('The document CONTRIBUTING.md states rules contributors to this repository must follow.');
    const paragraphs = (asked[1]!.state as { items: Record<string, unknown>[] }).items;
    expect(paragraphs).toEqual([{ k: 0, doc: 'CONTRIBUTING.md' }, { k: 1, doc: 'CONTRIBUTING.md' }, { k: 2, doc: 'CONTRIBUTING.md' }]);
    expect(asked[1]!.instructions[0]).toBe('This paragraph is a rule a contribution can break, not narrative or instruction: Contributing: Thanks for helping out.');
    expect(store.map.get('rules:mem')).toMatchObject({ version: 1, docs: ['CONTRIBUTING.md'] });
  });

  it('answers from the cache while the files and config are unchanged, and reruns when one changes', async () => {
    const asked: { state: unknown; instructions: string[] }[] = [];
    const store = memoryStore();
    const judge = judgeBy(isRuleDoc, isRule, asked);
    const first = await discoverRules(memorySource(files), rules(), judge, store);
    const again = await discoverRules(memorySource(files), rules(), judge, store);
    expect(again).toEqual({ ...first, cached: true });
    expect(asked).toHaveLength(2);
    const edited = { ...files, 'CONTRIBUTING.md': `${files['CONTRIBUTING.md']}- Tests must pass.\n` };
    const third = await discoverRules(memorySource(edited), rules(), judge, store);
    expect(third.cached).toBe(false);
    expect(third.rules.map((r) => r.text)).toContain('Contributing: Tests must pass.');
    expect(asked).toHaveLength(4);
    await discoverRules(memorySource(edited), rules({ exclude: ['README.md'] }), judge, store);
    expect(asked).toHaveLength(6);
    await discoverRules(memorySource(edited, { scope: 'other' }), rules({ exclude: ['README.md'] }), judge, store);
    expect(asked).toHaveLength(8);
  });

  it('adds listed docs without judging them as documents, removes excluded paths, and reads forge templates', async () => {
    const asked: { state: unknown; instructions: string[] }[] = [];
    const source = memorySource(files, { templates: { '.github/PULL_REQUEST_TEMPLATE.md': 'dup', '.github/ISSUE_TEMPLATE/bug.yml': 'name: Bug\nbody:\n  - type: markdown\n' }, remote: { 'o/r:MIGRATION.md@v2': '# Migration\n\nCallers must pass len.\n' } });
    const found = await discoverRules(source, rules({ docs: ['README.md', 'o/r:MIGRATION.md@v2'], exclude: ['docs/**'] }), judgeBy(() => 0.1, isRule, asked), memoryStore());
    const docs = (asked[0]!.state as { items: { path: string }[] }).items.map((d) => d.path);
    expect(docs).toEqual(['.github/PULL_REQUEST_TEMPLATE.md', 'CONTRIBUTING.md', '.github/ISSUE_TEMPLATE/bug.yml']);
    expect(found.candidates).toBe(3);
    expect(found.kept).toBe(0);
    // README.md holds no rule, so it is not named as used; the remote doc is
    expect(found.docs).toEqual(['o/r:MIGRATION.md@v2']);
    expect(found.rules).toEqual([{ source: 'o/r:MIGRATION.md@v2', text: 'Migration: Callers must pass len.' }]);
  });

  it('finds nothing in a repository without prose and asks nothing', async () => {
    const asked: { state: unknown; instructions: string[] }[] = [];
    const found = await discoverRules(memorySource({ 'src/a.ts': 'x' }), rules(), yesJudge(0.9, asked), memoryStore());
    expect(found).toEqual({ docs: [], rules: [], candidates: 0, kept: 0, cached: false });
    expect(asked).toHaveLength(0);
  });

  it('reports a judge failure and caches nothing', async () => {
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'off' }) };
    const store = memoryStore();
    const found = await discoverRules(memorySource(files), rules(), off, store);
    expect(found).toMatchObject({ docs: [], rules: [], error: 'disabled: off', cached: false });
    expect(store.map.size).toBe(0);
  });

  it('reads a checkout from git ls-files and the working tree, a repository from the forge tree', async () => {
    const git = async (args: string[]) => (args[0] === 'ls-files' ? 'README.md\0src/a.ts\0docs/pull_request_template.md\0.github/ISSUE_TEMPLATE/bug.yml\0.github/ISSUE_TEMPLATE/config.yml\0.github/ISSUE_TEMPLATE/gone.md\0' : '');
    const tree: Record<string, string> = { '/r/README.md': '# r', '/r/docs/pull_request_template.md': '## Summary', '/r/.github/ISSUE_TEMPLATE/bug.yml': 'name: Bug', '/r/.github/ISSUE_TEMPLATE/config.yml': 'blank_issues_enabled: false' };
    const templates = vi.fn(async () => [{ kind: 'pr' as const, name: 'docs/pull_request_template.md', body: '## Summary' }]);
    const forge = fakeForge({ template: templateKind, templates, file: async (repo, path, ref) => (repo === 'o/r' && path === 'RULES.md' ? `# rules@${ref ?? 'default'}` : undefined), contents: async () => ['RULES.md', 'src/a.ts'] });
    const local = checkoutSource('/r', git, { read: async (p) => tree[p]!, exists: async (p) => p in tree }, forge);
    expect(local.scope).toBe('/r');
    expect(await local.list()).toEqual(['README.md', 'src/a.ts', 'docs/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/gone.md']);
    expect(await local.read('README.md')).toBe('# r');
    expect(await local.read('gone.md')).toBeUndefined();
    // templates are the tracked paths at the forge's documented locations, read from the tree, never from the forge
    expect(await local.templates()).toEqual([
      { path: 'docs/pull_request_template.md', text: '## Summary' },
      { path: '.github/ISSUE_TEMPLATE/bug.yml', text: 'name: Bug' },
    ]);
    expect(templates).not.toHaveBeenCalled();
    expect(await checkoutSource('/r', git, { read: async (p) => tree[p]!, exists: async (p) => p in tree }).templates()).toEqual([]);
    expect(await local.remote('o/r', 'RULES.md', 'v1')).toBe('# rules@v1');
    const remote = forgeSource(forge, 'o/r', 'dev');
    expect(remote.scope).toBe('o/r@dev');
    expect(await remote.list()).toEqual(['RULES.md', 'src/a.ts']);
    expect(await remote.read('RULES.md')).toBe('# rules@dev');
    expect(await remote.templates()).toEqual([{ path: 'docs/pull_request_template.md', text: '## Summary' }]);
    expect(templates).toHaveBeenCalledTimes(1);
  });
});

describe('rules subject', () => {
  const files = { 'CONTRIBUTING.md': '# Rules\n\n- No em dashes.\n- Tests must pass.\n' };

  it('carries the discovered rules, names the documents in rules.present, and sends each rule once in its question', async () => {
    const s = await rulesSubject({ source: memorySource(files), judge: yesJudge(), store: memoryStore() }, { kind: 'text', ref: 'hello' }, resolveConfig(undefined));
    expect(s.facts['rules']).toEqual([{ source: 'CONTRIBUTING.md', text: 'Rules: No em dashes.' }, { source: 'CONTRIBUTING.md', text: 'Rules: Tests must pass.' }]);
    expect(s.facts['docs']).toEqual(['CONTRIBUTING.md']);
    expect(s.judgeError).toBeUndefined();
    const asked: { state: unknown; instructions: string[] }[] = [];
    const report = await runPack(BUILTIN_PACKS['rules']!, s, yesJudge(0.9, asked), resolveConfig(undefined));
    expect(report.mechanical).toEqual([{ check: 'rules.present', severity: 'info', message: '2 rules from CONTRIBUTING.md' }]);
    expect(report.verdict).toBe('pass');
    expect(asked[0]!.state).toEqual({ subject: { kind: 'text', text: 'hello' }, items: [{ k: 0 }, { k: 1 }] });
    expect(asked[0]!.instructions).toEqual(['The subject complies with this rule: Rules: No em dashes.', 'The subject complies with this rule: Rules: Tests must pass.']);
  });

  it('says the rules came from the cache', async () => {
    const store = memoryStore();
    const host = { source: memorySource(files), judge: yesJudge(), store };
    await rulesSubject(host, { kind: 'text', ref: 'a' }, resolveConfig(undefined));
    const s = await rulesSubject(host, { kind: 'text', ref: 'b' }, resolveConfig(undefined));
    const report = await runPack(BUILTIN_PACKS['rules']!, s, yesJudge(), resolveConfig(undefined));
    expect(report.mechanical[0]!.message).toBe('2 rules from CONTRIBUTING.md (cached)');
  });

  it('carries a discovery failure into the report as an unknown verdict', async () => {
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'unavailable', message: 'down', backend: 'off' }) };
    const s = await rulesSubject({ source: memorySource(files), judge: off, store: memoryStore() }, { kind: 'text', ref: 'x' }, resolveConfig(undefined));
    expect(s.judgeError).toBe('rule discovery: unavailable: down');
    const report = await runPack(BUILTIN_PACKS['rules']!, s, off, resolveConfig(undefined));
    expect(report.verdict).toBe('unknown');
    expect(report.judgeError).toBe('rule discovery: unavailable: down');
    expect(report.mechanical).toEqual([{ check: 'rules.present', severity: 'info', message: 'no rules found in 1 candidate document' }]);
  });

  it('parses paragraphs, list items and table rows', () => {
    expect(ruleParagraphs('# Style\n\nNo em dashes, no semicolons.\n\n- Conventional commits.\n- Tiny.\n\n```\ncode ignored\n```')).toEqual(['Style: No em dashes, no semicolons.', 'Style: Conventional commits.']);
    const doc = '## Sorting (#655)\n\n`sort` no longer takes a comparator.\n\n| 5.x | 6.0.0 |\n| --- | --- |\n| `sort.sort[T](data, len, cmp)` | `sort.sort[T](data, len)` |\n| `sort.is_sorted[T](d, n, cmp)` | `sort.is_sorted_by[T](d, n, cmp)` |\nA line after the table.\n';
    expect(ruleParagraphs(doc)).toEqual([
      'Sorting (#655): `sort` no longer takes a comparator.',
      'Sorting (#655): 5.x: `sort.sort[T](data, len, cmp)`; 6.0.0: `sort.sort[T](data, len)`',
      'Sorting (#655): 5.x: `sort.is_sorted[T](d, n, cmp)`; 6.0.0: `sort.is_sorted_by[T](d, n, cmp)`',
      'Sorting (#655): A line after the table.',
    ]);
  });
});
