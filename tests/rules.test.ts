import { describe, expect, it } from 'vitest';
import { templateKind } from '../src/forge/github.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/repo/config.ts';
import { rulesSubjects, textRulesSubjects } from '../src/repo/subjects.ts';
import { gateOutbound } from '../src/gate/outbound.ts';
import type { Judge } from '../src/judge/types.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { runPack } from '../src/packs/run.ts';
import { candidate, checkoutSource, contributingGuide, discoverRules, excluded, forgeSource, PARAGRAPH_QUESTION, ruleDoc, type RuleSource } from '../src/rules/discover.ts';
import { ruleParagraphs } from '../src/rules/paragraphs.ts';
import { TEXT_KIND_NAMES } from '../src/rules/kinds.ts';
import { rulesKeys, STALE_MS, StoreKeys } from '../src/keys.ts';
import { fakeForge } from './fake-forge.ts';
import { discoveries, memorySource, memoryStore, verdicts, yesJudge } from './fake-source.ts';

// a fixed clock: the cache's read mark is not what these tests check
const now = () => 1;
const D = 24 * 3600 * 1000;
const quiet = () => {};

const rules = (over: Partial<typeof DEFAULT_CONFIG.rules> = {}) => ({ ...DEFAULT_CONFIG.rules, ...over });

// answers the document question by path, the paragraph question by text, and whether text can break it (yes unless told)
function judgeBy(docs: (path: string) => number, paragraphs: (text: string) => number, asked: { state: unknown; instructions: string[] }[] = [], texts: (text: string) => number = () => 0.9, kinds: (kind: string, text: string) => number = () => 0.9): Judge {
  return {
    name: 'fake',
    ask: async (state, q) => {
      asked.push({ state, instructions: Object.values(q).map((x) => x.instructions) });
      const answers = Object.fromEntries(
        Object.entries(q).map(([k, x]) => {
          const doc = /^The document (.+) states rules/.exec(x.instructions);
          const text = /can follow or break this paragraph: (.*)$/s.exec(x.instructions);
          const kind = /this paragraph governs (.+?): (.*)$/s.exec(x.instructions);
          const p = doc ? docs(doc[1]!) : text ? texts(text[1]!) : kind ? kinds(kind[1]!, kind[2]!) : paragraphs(x.instructions.replace(/^.*not a description of what the software does: /, ''));
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
    'docs/style.md': '# Style\n\nA few notes on style.\n\n- Never a semicolon.\n',
    'src/README.md': '# src\n\nNever a candidate.\n',
    '.github/PULL_REQUEST_TEMPLATE.md': '## Summary\n\n## Testing\n',
  };
  // the style guide is unclear to the judge, everything else confidently no rules; the contributing guide is never asked
  const isRuleDoc = (p: string) => (p === 'docs/style.md' ? 0.5 : 0.1);
  const isRule = (t: string) => (/commits|em dashes|must|Never/.test(t) ? 0.9 : 0.2);

  it('ranks the candidates, keeps all but the ruled out and the contributing guide unjudged, then ranks the paragraphs of the kept', async () => {
    const asked: { state: unknown; instructions: string[] }[] = [];
    const store = memoryStore();
    const logged: string[] = [];
    const found = await discoverRules(memorySource(files), rules(), judgeBy(isRuleDoc, isRule, asked), store, now, (t) => logged.push(t));
    expect(found).toEqual({
      docs: ['CONTRIBUTING.md', 'docs/style.md'],
      rules: [
        { source: 'CONTRIBUTING.md', text: 'Contributing: Conventional commits, the issue number as the scope.', scope: { text: true, kinds: TEXT_KIND_NAMES } },
        { source: 'CONTRIBUTING.md', text: 'Contributing: No em dashes anywhere.', scope: { text: true, kinds: TEXT_KIND_NAMES } },
        { source: 'docs/style.md', text: 'Style: Never a semicolon.', scope: { text: true, kinds: TEXT_KIND_NAMES } },
      ],
      candidates: 5,
      kept: ['CONTRIBUTING.md', 'docs/style.md'],
      cached: false,
    });
    // one batched request per rank: the judged documents with a path, an excerpt and their headings, then the paragraphs of
    // each kept document beside that document
    expect(asked).toHaveLength(3);
    const docs = (asked[0]!.state as { items: { k: number; path: string; excerpt: string; headings: string[] }[] }).items;
    expect(docs.map((d) => d.path)).toEqual(['.github/PULL_REQUEST_TEMPLATE.md', 'README.md', 'docs/design/notes.md', 'docs/style.md']);
    expect(docs[3]).toEqual({ k: 3, path: 'docs/style.md', excerpt: '# Style\nA few notes on style.\n- Never a semicolon.', headings: ['Style'] });
    expect(docs[0]!.headings).toEqual(['Summary', 'Testing']);
    expect(asked[0]!.instructions[3]).toBe('The document docs/style.md states rules contributors to this repository must follow.');
    const paragraphs = asked.slice(1).map((a) => a.state as { document: { path: string; excerpt: string; headings: string[] }; items: Record<string, unknown>[] });
    expect(paragraphs.map((p) => p.document.path)).toEqual(['CONTRIBUTING.md', 'docs/style.md']);
    expect(paragraphs[1]!.document).toEqual({ path: 'docs/style.md', excerpt: '# Style\nA few notes on style.\n- Never a semicolon.', headings: ['Style'] });
    expect(paragraphs.map((p) => p.items.length)).toEqual([3, 2]);
    expect(asked[1]!.instructions[0]).toBe('Read as part of the document in the state, this paragraph directs contributors, a rule a contribution can break, not a description of what the software does: Contributing: Thanks for helping out.');
    expect(store.map.get('rules:mem')).toMatchObject({ version: 7, docs: ['CONTRIBUTING.md', 'docs/style.md'], kept: ['CONTRIBUTING.md', 'docs/style.md'] });
    // the kept set is in the session log by name; a cached answer logs nothing new
    expect(logged).toEqual(['sift rules mem: 5 candidates, kept CONTRIBUTING.md, docs/style.md; 3 rules from CONTRIBUTING.md, docs/style.md']);
    await discoverRules(memorySource(files), rules(), judgeBy(isRuleDoc, isRule, asked), store, now, (t) => logged.push(t));
    expect(logged).toHaveLength(1);
  });

  it('keeps the contributing guide by name at the root, docs/ or .github/, whatever the judge would say of it', async () => {
    for (const p of ['CONTRIBUTING.md', 'contributing.rst', 'docs/CONTRIBUTING.md', '.github/contributing.md']) expect(contributingGuide(p), p).toBe(true);
    for (const p of ['src/CONTRIBUTING.md', 'docs/contributing-notes.md', 'CONTRIBUTORS.md', 'README.md', 'CONTRIBUTING']) expect(contributingGuide(p), p).toBe(false);
    const asked: { state: unknown; instructions: string[] }[] = [];
    const found = await discoverRules(memorySource({ '.github/CONTRIBUTING.md': '# Contributing\n\n- Commits must be signed.\n' }), rules(), judgeBy(() => 0, isRule, asked), memoryStore(), now, quiet);
    expect(found.kept).toEqual(['.github/CONTRIBUTING.md']);
    expect(found.rules).toEqual([{ source: '.github/CONTRIBUTING.md', text: 'Contributing: Commits must be signed.', scope: { text: true, kinds: TEXT_KIND_NAMES } }]);
    // no document question was asked, only the paragraphs
    expect(asked).toHaveLength(1);
    expect(asked[0]!.instructions[0]).toMatch(/^Read as part of the document in the state, this paragraph directs contributors/);
  });

  it('marks the scope read on every discovery, so the sweep keeps a cache in use and removes one no longer read', async () => {
    const store = memoryStore();
    const clock = { now: 100 * D };
    const tick = () => clock.now;
    const keys = new StoreKeys({ store, now: tick, log: () => {} });
    const judge = judgeBy(isRuleDoc, isRule);
    await discoverRules(memorySource(files), rules(), judge, store, tick, quiet);
    expect(store.map.get(rulesKeys('mem').seen)).toBe(100 * D);
    clock.now += STALE_MS - 1;
    // a cached answer marks the read too
    expect((await discoverRules(memorySource(files), rules(), judge, store, tick, quiet)).cached).toBe(true);
    expect(store.map.get(rulesKeys('mem').seen)).toBe(clock.now);
    clock.now += STALE_MS - 1;
    await keys.sweep('me');
    expect(store.map.has(rulesKeys('mem').cache)).toBe(true);
    clock.now += 1;
    await keys.sweep('me');
    expect([...store.map.keys()]).toEqual([]);
  });

  it('answers from the cache while the files and config are unchanged, and reruns when one changes', async () => {
    const asked: { state: unknown; instructions: string[] }[] = [];
    const store = memoryStore();
    const judge = judgeBy(isRuleDoc, isRule, asked);
    const first = await discoverRules(memorySource(files), rules(), judge, store, now, quiet);
    const again = await discoverRules(memorySource(files), rules(), judge, store, now, quiet);
    expect(again).toEqual({ ...first, cached: true });
    expect(asked).toHaveLength(3);
    const edited = { ...files, 'CONTRIBUTING.md': `${files['CONTRIBUTING.md']}- Tests must pass.\n` };
    const third = await discoverRules(memorySource(edited), rules(), judge, store, now, quiet);
    expect(third.cached).toBe(false);
    expect(third.rules.map((r) => r.text)).toContain('Contributing: Tests must pass.');
    expect(asked).toHaveLength(6);
    await discoverRules(memorySource(edited), rules({ exclude: ['README.md'] }), judge, store, now, quiet);
    expect(asked).toHaveLength(9);
    await discoverRules(memorySource(edited, { scope: 'other' }), rules({ exclude: ['README.md'] }), judge, store, now, quiet);
    expect(asked).toHaveLength(12);
  });

  it('keys a source with content ids on the ids alone, reading no file on a hit, and reruns when an id changes', async () => {
    const asked: { state: unknown; instructions: string[] }[] = [];
    const store = memoryStore();
    const judge = judgeBy(isRuleDoc, isRule, asked);
    const reads: string[] = [];
    const ided = (ids: Record<string, string>): RuleSource => {
      const s = memorySource(files, { ids });
      return { ...s, read: async (p) => (reads.push(p), s.read(p)) };
    };
    const ids = Object.fromEntries(Object.keys(files).map((p) => [p, `${p}-1`]));
    const first = await discoverRules(ided(ids), rules(), judge, store, now, quiet);
    expect(first.cached).toBe(false);
    reads.length = 0;
    expect(await discoverRules(ided(ids), rules(), judge, store, now, quiet)).toEqual({ ...first, cached: true });
    expect(reads).toEqual([]);
    expect(asked).toHaveLength(3);
    const third = await discoverRules(ided({ ...ids, 'CONTRIBUTING.md': 'CONTRIBUTING.md-2' }), rules(), judge, store, now, quiet);
    expect(third.cached).toBe(false);
    expect(asked).toHaveLength(6);
  });

  it('fails and caches nothing when a listed file cannot be read', async () => {
    const store = memoryStore();
    const s = memorySource(files, { ids: { 'CONTRIBUTING.md': 'c1' } });
    const found = await discoverRules({ ...s, read: async (p) => (p === 'CONTRIBUTING.md' ? undefined : s.read(p)) }, rules(), yesJudge(), store, now, quiet);
    expect(found).toMatchObject({ docs: [], rules: [], error: 'unreadable: CONTRIBUTING.md', cached: false });
    expect(store.map.size).toBe(0);
  });

  it('adds listed docs without judging them as documents, removes excluded paths, and reads templates that are not prose', async () => {
    const asked: { state: unknown; instructions: string[] }[] = [];
    const source = memorySource(files, { templates: { '.github/ISSUE_TEMPLATE/bug.yml': 'name: Bug\nbody:\n  - type: markdown\n' }, remote: { 'o/r:MIGRATION.md@v2': '# Migration\n\nCallers must pass len.\n' } });
    const found = await discoverRules(source, rules({ docs: ['README.md', 'o/r:MIGRATION.md@v2'], exclude: ['docs/**'] }), judgeBy(() => 0.1, isRule, asked), memoryStore(), now, quiet);
    const docs = (asked[0]!.state as { items: { path: string }[] }).items.map((d) => d.path);
    expect(docs).toEqual(['.github/ISSUE_TEMPLATE/bug.yml', '.github/PULL_REQUEST_TEMPLATE.md']);
    expect(found.candidates).toBe(3);
    // the listed docs and the contributing guide, never a judged document ruled out
    expect(found.kept).toEqual(['README.md', 'o/r:MIGRATION.md@v2', 'CONTRIBUTING.md']);
    // README.md holds no rule, so it is not named as used; the remote doc is
    expect(found.docs).toEqual(['o/r:MIGRATION.md@v2', 'CONTRIBUTING.md']);
    expect(found.rules[0]).toEqual({ source: 'o/r:MIGRATION.md@v2', text: 'Migration: Callers must pass len.', scope: { text: true, kinds: TEXT_KIND_NAMES } });
  });

  it('finds nothing in a repository without prose and asks nothing', async () => {
    const asked: { state: unknown; instructions: string[] }[] = [];
    const found = await discoverRules(memorySource({ 'src/a.ts': 'x' }), rules(), yesJudge(0.9, asked), memoryStore(), now, quiet);
    expect(found).toEqual({ docs: [], rules: [], candidates: 0, kept: [], cached: false });
    expect(asked).toHaveLength(0);
  });

  it('reports a judge failure and caches nothing', async () => {
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'off' }) };
    const store = memoryStore();
    const logged: string[] = [];
    const found = await discoverRules(memorySource(files), rules(), off, store, now, (t) => logged.push(t));
    expect(found).toMatchObject({ docs: [], rules: [], error: 'disabled: off', cached: false });
    expect(store.map.size).toBe(0);
    expect(logged).toEqual(['sift rules mem: discovery failed, nothing cached (disabled: off)']);
  });

  // an outage at either rank step, or a judge that answers ok with an item missing, leaves no cache, and the next call asks again
  it.each([
    ['an outage at the document step', (q: string) => q.startsWith('The document'), false],
    ['an outage at the paragraph step', (q: string) => q.startsWith('Read as part of the document'), false],
    ['an answer missing at the document step', (q: string) => q.startsWith('The document'), true],
    ['an answer missing at the paragraph step', (q: string) => q.startsWith('Read as part of the document'), true],
  ])('caches nothing after %s and rediscovers on the next call', async (_, hit, omit) => {
    const healthy = judgeBy(isRuleDoc, isRule);
    const failing: Judge = {
      name: 'fake',
      ask: async (state, q) => {
        if (!Object.values(q).some((x) => hit(x.instructions))) return healthy.ask(state, q);
        if (!omit) return { ok: false, reason: 'unavailable', message: 'http 403: forbidden', backend: 'fake' };
        const answered = await healthy.ask(state, q);
        if (!answered.ok) return answered;
        const [first, ...rest] = Object.entries(answered.answers);
        return { ...answered, answers: Object.fromEntries(first ? rest : []) };
      },
    };
    const store = memoryStore();
    const down = await discoverRules(memorySource(files), rules(), failing, store, now, quiet);
    expect(down.error).toMatch(omit ? /^malformed: no answer for / : /^unavailable: http 403/);
    expect(down.rules).toEqual([]);
    expect(store.map.size).toBe(0);
    const asked: { state: unknown; instructions: string[] }[] = [];
    const up = await discoverRules(memorySource(files), rules(), judgeBy(isRuleDoc, isRule, asked), store, now, quiet);
    expect(up.cached).toBe(false);
    expect(asked).toHaveLength(3);
    expect(up.docs).toEqual(['CONTRIBUTING.md', 'docs/style.md']);
    expect(store.map.get(rulesKeys('mem').cache)).toMatchObject({ docs: ['CONTRIBUTING.md', 'docs/style.md'] });
  });

  // briar-systems/mach's root: the contributing guide opens with thanks and build steps, so its excerpt reads as a tutorial
  it('finds the contributing rules of a mach-shaped tree', async () => {
    const mach = {
      'CHANGELOG.md': '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n## [Unreleased]\n\n### Added\n\n- A shared library build warns at a `fwd` of a generic.\n',
      'CODE_OF_CONDUCT.md': '# Contributor Covenant Code of Conduct\n\n## Our Pledge\n\nWe pledge to make participation in our community a harassment-free experience for everyone.\n\n## Our Standards\n\n- Using welcoming and inclusive language.\n',
      'CONTRIBUTING.md': [
        '# Contributing to Mach',
        'Thank you for your interest in contributing to Mach. Be respectful, constructive, and professional.',
        '## Building',
        'Mach is self-hosting, so building it needs an existing Mach compiler.',
        '```bash\ngit clone https://github.com/briar-systems/mach.git\ncd mach\nmach build .\n```',
        '## Branches',
        'Feature and fix branches are named feat/<issue> or fix/<issue>, branch off dev and open their pull request against dev.',
        '## Commits',
        'Commit messages must follow conventional commits with the issue number as the scope: fix(#1234): description.',
        '## Pull requests',
        'Pull requests merge with a merge commit, never squash or rebase.',
      ].join('\n\n'),
      'README.md': '# MACH\n\n# Overview\n\nMach is a self hosted, statically-typed, compiled systems language.\n',
      'SECURITY.md': '# Security Policy\n\n## Reporting a Vulnerability\n\nPlease report security vulnerabilities privately rather than opening a public issue.\n',
      'doc/language/secrecy.md': '# Secrecy\n\nNot a candidate: doc/ is not docs/.\n',
      '.github/workflows/ci.yml': 'name: CI\n',
    };
    // what jev said of mach's excerpts: the code of conduct 0.83, the contributing guide 0.63 (unclear), security 0.21, the rest 0.03
    const docScore: Record<string, number> = { 'CODE_OF_CONDUCT.md': 0.83, 'CONTRIBUTING.md': 0.63, 'SECURITY.md': 0.21, 'CHANGELOG.md': 0.03, 'README.md': 0.03 };
    const isMachRule = (t: string) => (/must|never|named|report security|welcoming/i.test(t) ? 0.9 : 0.1);
    const asked: { state: unknown; instructions: string[] }[] = [];
    const logged: string[] = [];
    const found = await discoverRules(memorySource(mach), rules(), judgeBy((p) => docScore[p]!, isMachRule, asked), memoryStore(), now, (t) => logged.push(t));
    expect(found.candidates).toBe(5);
    expect(found.kept).toEqual(['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md']);
    expect(found.docs).toEqual(['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md']);
    expect(found.rules.filter((r) => r.source === 'CONTRIBUTING.md').map((r) => r.text)).toEqual([
      'Branches: Feature and fix branches are named feat/<issue> or fix/<issue>, branch off dev and open their pull request against dev.',
      'Commits: Commit messages must follow conventional commits with the issue number as the scope: fix(#1234): description.',
      'Pull requests: Pull requests merge with a merge commit, never squash or rebase.',
    ]);
    // the contributing guide is never put to the document question
    const judged = (asked[0]!.state as { items: { path: string }[] }).items.map((d) => d.path);
    expect(judged).toEqual(['CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'README.md', 'SECURITY.md']);
    expect(logged).toEqual(['sift rules mem: 5 candidates, kept CONTRIBUTING.md, CODE_OF_CONDUCT.md; 4 rules from CONTRIBUTING.md, CODE_OF_CONDUCT.md']);
  });

  it('keeps an unclear document the contributing prior does not cover, and drops one the judge rules out', async () => {
    const tree = { 'docs/workflow.md': '# Workflow\n\nHow we work.\n\n## Commits\n\n- Commits must be small.\n', 'SECURITY.md': '# Security\n\nReport privately.\n' };
    const found = await discoverRules(memorySource(tree), rules(), judgeBy((p) => (p === 'docs/workflow.md' ? 0.63 : 0.21), isRule), memoryStore(), now, quiet);
    expect(found.kept).toEqual(['docs/workflow.md']);
    expect(found.rules).toEqual([{ source: 'docs/workflow.md', text: 'Commits: Commits must be small.', scope: { text: true, kinds: TEXT_KIND_NAMES } }]);
  });

  // #188's pull request body was refused for "breaking" the readme's description of the pack it removed
  it('rules out a description of the software, so a pull request that removes a documented feature passes and the contributing rules still hold', async () => {
    const tree = {
      'README.md': '# sift\n\n## Packs\n\nA repo pack may declare `subject: log` to grade a failed job\'s log.\n',
      'CONTRIBUTING.md': '# Contributing\n\n- Commits use conventional format.\n',
    };
    // the paragraph question separates what directs a contributor from what describes the software
    expect(PARAGRAPH_QUESTION['rule']!.criteria).toMatchObject({ false: expect.stringContaining("describes what this repository's software does") });
    // a judge that answers the question as asked: the readme's sentence describes the software, the contributing line directs
    const directs = (t: string) => (/Commits use/.test(t) ? 0.9 : 0.1);
    const host = { source: memorySource(tree), discoveries: discoveries(judgeBy(() => 0.5, directs)) };
    const config = resolveConfig(undefined);
    const gate = async (text: string) => {
      const subjects = await textRulesSubjects(host, { text, about: 'the title and body of a new pull request' }, config);
      expect(subjects[0]!.facts['rules']).toEqual([{ source: 'CONTRIBUTING.md', text: 'Contributing: Commits use conventional format.', scope: { text: true, kinds: TEXT_KIND_NAMES } }]);
      // a gate judge that holds the removal against any rule naming the removed feature, and a bad commit subject against the format
      const gateJudge: Judge = {
        name: 'fake',
        ask: async (_s, q) => ({ ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.entries(q).map(([k, x]) => [k, { type: 'noul' as const, p: (/subject: log/.test(x.instructions) && /removes/.test(text)) || (/conventional format/.test(x.instructions) && !/^\w+(\(#\d+\))?!?: /.test(text)) ? 0.1 : 0.9 }])) }),
      };
      return gateOutbound({ channel: 'github-pr-create', text, kind: 'the title and body of a new pull request' }, subjects, BUILTIN_PACKS['rules']!, gateJudge, config, verdicts());
    };
    expect(await gate('feat(#188)!: remove the ci pack\n\nThis removes the `log` subject kind: a repo pack may no longer declare `subject: log`.')).toMatchObject({ allow: true, reason: 'clear' });
    expect(await gate('removed the ci pack')).toMatchObject({ allow: false, reason: 'breaks: CONTRIBUTING.md "Contributing: Commits use conventional format.": "removed the ci pack" does not follow it' });
  });

  it('reads a checkout from git ls-files and the working tree, a repository from the forge tree', async () => {
    const git = async (args: string[]) => (args[0] === 'ls-files' ? 'README.md\0src/a.ts\0docs/pull_request_template.md\0.github/ISSUE_TEMPLATE/bug.yml\0.github/ISSUE_TEMPLATE/config.yml\0.github/ISSUE_TEMPLATE/gone.md\0' : '');
    const tree: Record<string, string> = { '/r/README.md': '# r', '/r/docs/pull_request_template.md': '## Summary', '/r/.github/ISSUE_TEMPLATE/bug.yml': 'name: Bug', '/r/.github/ISSUE_TEMPLATE/config.yml': 'blank_issues_enabled: false' };
    const forge = fakeForge({ template: templateKind, file: async (repo, path, ref) => (repo === 'o/r' && path === 'RULES.md' ? `# rules@${ref ?? 'default'}` : undefined), contents: async () => [{ path: 'RULES.md', id: 'b1' }, { path: 'src/a.ts', id: 'b2' }] });
    const local = checkoutSource('/r', git, { read: async (p) => tree[p]!, exists: async (p) => p in tree }, forge);
    expect(local.scope).toBe('/r');
    // the working tree is read, so no path carries an id
    expect(await local.list()).toEqual(['README.md', 'src/a.ts', 'docs/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/gone.md'].map((path) => ({ path })));
    expect(await local.read('README.md')).toBe('# r');
    expect(await local.read('gone.md')).toBeUndefined();
    // templates are the paths at the forge's documented locations, named by the forge and read from the tree
    expect(['docs/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/config.yml', 'README.md'].map(local.template)).toEqual([true, true, false, false]);
    expect(checkoutSource('/r', git, { read: async (p) => tree[p]!, exists: async (p) => p in tree }).template('docs/pull_request_template.md')).toBe(false);
    expect(await local.remote('o/r', 'RULES.md', 'v1')).toBe('# rules@v1');
    const remote = forgeSource(forge, 'o/r', 'dev');
    expect(remote.scope).toBe('o/r@dev');
    expect(await remote.list()).toEqual([{ path: 'RULES.md', id: 'b1' }, { path: 'src/a.ts', id: 'b2' }]);
    expect(await remote.read('RULES.md')).toBe('# rules@dev');
    expect(remote.template('.github/PULL_REQUEST_TEMPLATE.md')).toBe(true);
  });
});

describe('rules subject', () => {
  const files = { 'CONTRIBUTING.md': '# Rules\n\n- No em dashes.\n- Tests must pass.\n' };

  it('carries the discovered rules, names the documents in rules.present, and sends each rule once in its question', async () => {
    const s = (await textRulesSubjects({ source: memorySource(files), discoveries: discoveries(yesJudge()) }, { text: 'hello' }, resolveConfig(undefined)))[0]!;
    expect(s.facts['rules']).toEqual([{ source: 'CONTRIBUTING.md', text: 'Rules: No em dashes.', scope: { text: true, kinds: TEXT_KIND_NAMES } }, { source: 'CONTRIBUTING.md', text: 'Rules: Tests must pass.', scope: { text: true, kinds: TEXT_KIND_NAMES } }]);
    expect(s.facts['docs']).toEqual(['CONTRIBUTING.md']);
    expect(s.judgeError).toBeUndefined();
    const asked: { state: unknown; instructions: string[] }[] = [];
    const report = await runPack(BUILTIN_PACKS['rules']!, s, yesJudge(0.9, asked), resolveConfig(undefined));
    expect(report.mechanical).toEqual([{ check: 'rules.present', severity: 'info', message: '2 rules from CONTRIBUTING.md' }]);
    expect(report.verdict).toBe('pass');
    expect(asked[0]!.state).toEqual({ subject: { kind: 'text', text: 'hello' }, items: [{ k: 0 }, { k: 1 }] });
    expect(asked[0]!.instructions).toEqual(['The subject complies with this rule: Rules: No em dashes.', 'The subject complies with this rule: Rules: Tests must pass.']);
  });

  // #219: a label convention was held against issue titles, which set no labels
  it('leaves a rule about metadata out of text to be written, and judges it against an issue that carries its labels', async () => {
    const tree = { 'CONTRIBUTING.md': '# Issues\n\n- Titles start with a conventional prefix.\n- Label every issue with where it lands: `testing`, `tooling` or `doc`.\n' };
    const labels = (t: string) => (/Label every issue/.test(t) ? 0.1 : 0.9);
    const host = { source: memorySource(tree), discoveries: discoveries(judgeBy(() => 0.5, () => 0.9, [], labels)) };
    const config = resolveConfig(undefined);
    const [text] = await textRulesSubjects(host, { text: 'comptime: a union build binds every arm', about: 'the title and body of a new GitHub issue' }, config);
    expect(text!.facts['rules']).toEqual([{ source: 'CONTRIBUTING.md', text: 'Issues: Titles start with a conventional prefix.', scope: { text: true, kinds: TEXT_KIND_NAMES } }]);
    const asked: { state: unknown; instructions: string[] }[] = [];
    const report = await runPack(BUILTIN_PACKS['rules']!, text!, yesJudge(0.9, asked), config);
    expect(report.mechanical).toEqual([{ check: 'rules.present', severity: 'info', message: '1 rule from CONTRIBUTING.md, 1 that do not govern the subject left out' }]);
    expect(asked.flatMap((a) => a.instructions).some((i) => /Label every issue/.test(i))).toBe(false);
    const [issue] = await rulesSubjects(host, { number: 5, pack: 'rules' }, config);
    expect((issue!.facts['rules'] as { text: string }[]).map((r) => r.text)).toEqual(['Issues: Titles start with a conventional prefix.', 'Issues: Label every issue with where it lands: `testing`, `tooling` or `doc`.']);
    // a document of metadata rules alone leaves text nothing to be judged against
    const only = { source: memorySource({ 'CONTRIBUTING.md': '# Issues\n\n- Label every issue with where it lands.\n' }), discoveries: discoveries(judgeBy(() => 0.5, () => 0.9, [], labels)) };
    const [none] = await textRulesSubjects(only, { text: 'x' }, config);
    expect((await runPack(BUILTIN_PACKS['rules']!, none!, yesJudge(), config)).mechanical).toEqual([{ check: 'rules.present', severity: 'info', message: 'none of the 1 rule found governs the subject' }]);
  });

  it('fails a discovery the judge does not say the scope of, so nothing is cached', async () => {
    const partial: Judge = {
      name: 'partial',
      ask: async (_s, q) => ({ ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.entries(q).filter(([, x]) => !/can follow or break this paragraph/.test(x.instructions)).map(([k]) => [k, { type: 'noul' as const, p: 0.9 }])) }),
    };
    const store = memoryStore();
    const found = await discoverRules(memorySource(files), rules(), partial, store, now, quiet);
    expect(found.error).toBe('malformed: no answer for 2 of 2 paragraphs in CONTRIBUTING.md');
    expect(store.map.get('rules:mem')).toBeUndefined();
  });

  it('says the rules came from the cache', async () => {
    const store = memoryStore();
    const host = { source: memorySource(files), discoveries: discoveries(yesJudge(), store) };
    await textRulesSubjects(host, { text: 'a' }, resolveConfig(undefined));
    const s = (await textRulesSubjects(host, { text: 'b' }, resolveConfig(undefined)))[0]!;
    const report = await runPack(BUILTIN_PACKS['rules']!, s, yesJudge(), resolveConfig(undefined));
    expect(report.mechanical[0]!.message).toBe('2 rules from CONTRIBUTING.md (cached)');
  });

  it('carries a discovery failure into the report as an unknown verdict', async () => {
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'unavailable', message: 'down', backend: 'off' }) };
    const s = (await textRulesSubjects({ source: memorySource(files), discoveries: discoveries(off) }, { text: 'x' }, resolveConfig(undefined)))[0]!;
    expect(s.judgeError).toBe('rule discovery: unavailable: down');
    const report = await runPack(BUILTIN_PACKS['rules']!, s, off, resolveConfig(undefined));
    expect(report.verdict).toBe('unknown');
    expect(report.judgeError).toBe('rule discovery: unavailable: down');
    expect(report.mechanical).toEqual([{ check: 'rules.present', severity: 'info', message: 'no rules found in 1 candidate document, kept CONTRIBUTING.md' }]);
  });

  it('answers pending when discovery outlasts its wait, and the next call joins the run it left going', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const asked: { state: unknown; instructions: string[] }[] = [];
    const inner = yesJudge(0.9, asked);
    const slow: Judge = { name: 'slow', ask: async (state, q) => (await gate, inner.ask(state, q)) };
    const timers: (() => void)[] = [];
    const store = memoryStore();
    const host = { source: memorySource(files), discoveries: discoveries(slow, store, { schedule: (_, fn) => (timers.push(fn), { cancel: () => {} }), waitMs: 5_000 }) };
    const first = textRulesSubjects(host, { text: 'a' }, resolveConfig(undefined)).then((s) => s[0]!);
    await Promise.resolve();
    timers.shift()!();
    const s = await first;
    const pending = 'rule discovery for mem outlasted its 5 s wait and keeps running; the next call on it reuses what it finds';
    expect(s).toMatchObject({ judgeError: pending, pending });
    const report = await runPack(BUILTIN_PACKS['rules']!, s, inner, resolveConfig(undefined));
    expect(report.verdict).toBe('unknown');
    // the second call joins the same run rather than starting another, and answers once it lands
    const second = textRulesSubjects(host, { text: 'b' }, resolveConfig(undefined)).then((s) => s[0]!);
    release();
    const done = await second;
    expect(done.pending).toBeUndefined();
    // the pending answer settles with the run it left going, found without a failure
    expect(await s.settled).toBeUndefined();
    expect(done.facts['docs']).toEqual(['CONTRIBUTING.md']);
    // one paragraph round, the contributing guide being kept unjudged: a second run would have asked again
    expect(asked).toHaveLength(1);
    expect(store.map.size).toBeGreaterThan(0);
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
