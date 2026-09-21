import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/github/config.ts';
import type { Judge } from '../src/judge/types.ts';
import { excerptOf, ignored, indexTree, symbolsOf, treeSubject, type Tree } from '../src/locate/tree.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { validatePack } from '../src/packs/load.ts';
import { formatReport, narrow, runPack } from '../src/packs/run.ts';

const FILES: Record<string, string> = {
  'src/packs/run.ts': "import { rank } from '../judge/rank.ts';\n\nexport type Step = { from: string };\n\nexport async function runPack() {}\nexport { materialize as build, type Meta }\n",
  'src/packs/types.ts': 'export type Pack = { name: string };\n',
  'src/judge/rank.ts': 'export function rank() {}\n',
  'README.md': '# sift\n\nA plugin.\n\n## Packs\n\ntext\n',
  'package-lock.json': '{}',
  'assets/logo.png': 'PNG',
  'node_modules/x/index.js': 'module.exports = 1',
  'big/blob.txt': 'x'.repeat(10),
  'bin/tool': 'abc\0def',
};

const tree: Tree = {
  list: async () => [...Object.keys(FILES), ''],
  size: async (p) => (p === 'big/blob.txt' ? 999_999 : FILES[p]!.length),
  read: async (p) => FILES[p]!,
};

describe('file index', () => {
  it('skips dependency trees, lockfiles, binaries, the size bound and files with nul bytes', () => {
    expect(ignored('node_modules/x/index.js')).toBe(true);
    expect(ignored('package-lock.json')).toBe(true);
    expect(ignored('assets/logo.png')).toBe(true);
    expect(ignored('dist/app.min.js')).toBe(true);
    expect(ignored('src/packs/run.ts')).toBe(false);
  });

  it('indexes paths, excerpts and symbols and groups them by directory', async () => {
    const index = await indexTree(tree);
    expect(index.files.map((f) => f.path)).toEqual(['src/packs/run.ts', 'src/packs/types.ts', 'src/judge/rank.ts', 'README.md']);
    expect(index.skipped).toBe(5);
    expect(index.dirs).toEqual([
      { path: '.', files: 1, sample: ['README.md'] },
      { path: 'src/judge', files: 1, sample: ['rank.ts'] },
      { path: 'src/packs', files: 2, sample: ['run.ts', 'types.ts'] },
    ]);
    const run = index.files[0]!;
    expect(run.dir).toBe('src/packs');
    expect(run.symbols).toEqual(['Step', 'runPack', 'build', 'Meta']);
    expect(run.excerpt.split('\n')).toHaveLength(4);
  });

  it('finds symbols per language and cuts the excerpt', () => {
    expect(symbolsOf('a.py', 'import os\n\nclass Foo:\n  pass\n\nasync def bar():\n  pass\n')).toEqual(['Foo', 'bar']);
    expect(symbolsOf('a.go', 'package a\n\nfunc (s *S) Do() {}\nfunc New() {}\ntype S struct{}\n')).toEqual(['Do', 'New', 'S']);
    expect(symbolsOf('a.rs', 'pub fn go() {}\nfn hidden() {}\npub(crate) struct X;\n')).toEqual(['go', 'X']);
    expect(symbolsOf('a.c', 'static int helper(int x) {\nstruct point { int x; };\n#define MAX 3\n')).toEqual(['helper', 'point', 'MAX']);
    expect(symbolsOf('a.mach', 'pub fun add(a: i64) i64 {\npub tag Status: u8 {\nfun main() {\n')).toEqual(['add', 'Status', 'main']);
    expect(symbolsOf('a.md', '# Title, with comma\n\n## Packs\n')).toEqual(['Title, with comma', 'Packs']);
    expect(excerptOf('\n\n  abc  \nb\n\nc\nd\n', 3, 2)).toBe('ab…\nb\nc');
  });
});

// a judge that likes anything under src/packs and the pack types file, in batched rank keys
const picky: Judge = {
  name: 'fake',
  ask: async (state, questions) => {
    const items = (state as { items: Record<string, unknown>[] }).items;
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => {
        const k = Number(key.slice(key.lastIndexOf('_') + 1));
        const path = String(items.find((i) => i['k'] === k)!['path']);
        const p = path === 'src/packs' ? 0.9 : path === 'src/packs/types.ts' ? 0.8 : path === 'src/packs/run.ts' ? 0.5 : path === 'src/judge' ? 0.2 : 0.1;
        return [key, { type: 'noul' as const, p }];
      }),
    );
    return { ok: true, backend: 'fake', latencyMs: 1, answers };
  },
};

describe('locate pack', () => {
  it('ranks directories, then only the files of those not ruled out, and lists the top of each', async () => {
    const subject = treeSubject('add a rank step to packs', 'text', await indexTree(tree));
    const report = await runPack(BUILTIN_PACKS['locate']!, subject, picky, DEFAULT_CONFIG, { top: 1 });
    expect(report.mechanical).toEqual([{ check: 'tree.indexed', severity: 'info', message: '4 files in 3 directories indexed, 5 skipped' }]);
    expect(report.judged).toEqual([]);
    expect(report.ranked.map((r) => [r.step, r.total, r.kept, r.items.map((i) => i.label)])).toEqual([
      ['dirs', 3, 1, ['src/packs']],
      ['files', 2, 1, ['src/packs/types.ts']],
    ]);
    expect(report.ranked[1]!.items[0]).toMatchObject({ id: 'files_2', band: 'satisfied', answer: { p: 0.8 }, instructions: 'The file src/packs/types.ts must be read or changed to implement this.' });
    expect(report.verdict).toBe('pass');
    expect(formatReport(report).split('\n').slice(2)).toEqual(['  dirs: top 1 of 3, 1 not ruled out', '    1. [satisfied] src/packs = 0.90', '  files: top 1 of 2, 1 not ruled out', '    1. [satisfied] src/packs/types.ts = 0.80']);
  });

  it('shows the pack default of twenty and ranks nothing under an empty index', async () => {
    const full = await runPack(BUILTIN_PACKS['locate']!, treeSubject('x', 'text', await indexTree(tree)), picky, DEFAULT_CONFIG);
    expect(full.ranked[0]!.items.map((i) => i.label)).toEqual(['src/packs', 'src/judge', '.']);
    const empty = await runPack(BUILTIN_PACKS['locate']!, treeSubject('x', 'text', { dirs: [], files: [], skipped: 3 }), picky, DEFAULT_CONFIG);
    expect(empty.mechanical[0]).toMatchObject({ severity: 'warn' });
    expect(empty.ranked.map((r) => r.total)).toEqual([0, 0]);
    expect(empty.verdict).toBe('warn');
  });

  it('narrows by a field of the kept items and validates rank steps in pack files', () => {
    expect(narrow([{ dir: 'a', path: 'a/1' }, { dir: 'b', path: 'b/1' }], { field: 'dir', of: 'path' }, [{ path: 'b' }])).toEqual([{ dir: 'b', path: 'b/1' }]);
    expect(narrow([{ dir: 'a' }], undefined, [])).toEqual([{ dir: 'a' }]);
    const q = { type: 'noul', instructions: '{path}' };
    expect(validatePack({ subject: 'tree', rank: [{ from: 'files', questions: { q } }] }, 'ok').rank).toHaveLength(1);
    expect(() => validatePack({ subject: 'tree', rank: [{ questions: { q } }] }, 'bad')).toThrow(/needs from/);
    expect(() => validatePack({ subject: 'rules', expand: { from: 'rules', template: q } }, 'old')).toThrow(/expand is gone/);
    expect(() => validatePack({ subject: 'tree', rank: [{ from: 'files', questions: {} }] }, 'bad')).toThrow(/at least one question/);
    expect(() => validatePack({ subject: 'tree', rank: [{ from: 'files', questions: { q }, by: 'zz' }] }, 'bad')).toThrow(/unknown question zz/);
    expect(() => validatePack({ subject: 'tree', rank: [{ from: 'files', questions: { q }, list: 'some' }] }, 'bad')).toThrow(/each or top/);
    expect(() => validatePack({ subject: 'tree', rank: [{ from: 'files', questions: { q }, order: 'size' }] }, 'bad')).toThrow(/value or input/);
    expect(() => validatePack({ subject: 'tree', rank: [{ from: 'files', questions: { q }, feed: '' }] }, 'bad')).toThrow(/feed must name/);
  });
});
