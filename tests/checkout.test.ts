import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Forge } from '../src/forge/forge.ts';
import { grade, scopeOf, SpawnDirs, subjectFor, type GradeHost, type GradeScope } from '../src/grade.ts';
import type { Judge } from '../src/judge/types.ts';
import { Checkouts, type CheckoutFs } from '../src/repo/checkout.ts';
import type { RunLike } from '../src/process.ts';
import { fakeForge } from './fake-forge.ts';
import { memoryStore } from './fake-source.ts';

const run: RunLike = async (argv, init) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: init?.cwd, encoding: 'utf8', input: init?.stdin });
  return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};

const fs: CheckoutFs = {
  read: async (p) => readFileSync(p, 'utf8'),
  exists: async (p) => existsSync(p),
  list: async (p) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, kind: e.isFile() ? 'file' : e.isDirectory() ? 'directory' : 'other' })),
  stat: async (p) => statSync(p),
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function write(path: string, text: string): void {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, text);
}

const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'off' }) };

// two repositories: a is the session's, b is another with a worktree on a branch of its own and an uncommitted changelog
let base: string;
let a: string;
let b: string;
let wt: string;
let lookups: string[];
let checkouts: Checkouts;
let host: GradeHost;
let issuesRead: string[];

const forgeAt = (dir: string): Forge => {
  lookups.push(dir);
  return fakeForge({ checkout: async () => ({ repo: dir === a ? 'o/a' : 'o/b', defaultBranch: 'main' }) });
};

beforeAll(() => {
  base = mkdtempSync(`${tmpdir()}/sift-checkout-`);
  a = `${base}/a`;
  b = `${base}/b`;
  wt = `${base}/b-wt`;
  mkdirSync(a);
  git(a, 'init', '-q');
  write(`${a}/.sift/config.json`, JSON.stringify({ prs: { targets: ['dev'] } }));
  write(`${a}/a.txt`, 'a\n');
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'feat(#1): a');

  mkdirSync(b);
  git(b, 'init', '-q');
  write(`${b}/.sift/config.json`, JSON.stringify({ prs: { targets: ['trunk'] }, release: { changelog: 'CHANGELOG.md' } }));
  write(`${b}/.sift/packs/only-b.json`, JSON.stringify({ subject: 'commit', checks: ['commit.format'] }));
  write(`${b}/CONTRIBUTING.md`, '# Contributing\n\nEvery commit names its issue.\n');
  write(`${b}/CHANGELOG.md`, '# Changelog\n');
  git(b, 'add', '-A');
  git(b, 'commit', '-q', '-m', 'chore: b');
  git(b, 'worktree', 'add', '-q', '-b', 'fix/2', wt);
  write(`${wt}/b.txt`, 'b\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'fix(#2): in the worktree');
  write(`${wt}/CHANGELOG.md`, '# Changelog\n\n- an unreleased line\n');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function fresh(remote: Record<string, string> = {}): void {
  lookups = [];
  checkouts = new Checkouts({ run, fs, forgeAt, base: () => undefined });
  issuesRead = [];
  const plain = fakeForge();
  const forge = fakeForge({
    file: async (repo, path) => remote[`${repo}:${path}`],
    defaultBranch: async () => 'main',
    issue: async (repo, n) => (issuesRead.push(`${repo}#${n}`), plain.issue(repo, n)),
  });
  host = { forge, judge: off, store: memoryStore(), fs, checkouts };
}

const session = () => checkouts.resolve(a);
const named = async (dir: string): Promise<GradeScope> => ({ checkout: await checkouts.resolve(dir), named: true });
const sessionScope = async (): Promise<GradeScope> => ({ checkout: await session(), named: false });

describe('a checkout per directory', () => {
  it('resolves the worktree itself, its repository, its conventions and its packs', async () => {
    fresh();
    const c = await checkouts.resolve(`${wt}/.sift`);
    expect(c.root).toBe(wt);
    expect(c.repo).toBe('o/b');
    expect(c.config.prs.targets).toEqual(['trunk']);
    expect(c.packs['only-b']).toBeDefined();
    const s = await session();
    expect(s.root).toBe(a);
    expect(s.config.prs.targets).toEqual(['dev']);
    expect(s.packs['only-b']).toBeUndefined();
  });

  it('looks the repository up once per root and rereads the conventions when .sift changes', async () => {
    fresh();
    await checkouts.resolve(wt);
    const path = `${wt}/.sift/config.json`;
    const before = readFileSync(path, 'utf8');
    try {
      writeFileSync(path, JSON.stringify({ prs: { targets: ['next'] } }));
      utimesSync(path, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
      expect((await checkouts.resolve(wt)).config.prs.targets).toEqual(['next']);
      expect(lookups).toEqual([wt]);
    } finally {
      writeFileSync(path, before);
      utimesSync(path, Date.now() / 1000 + 20, Date.now() / 1000 + 20);
    }
  });

  it('refuses a relative or missing cwd', async () => {
    fresh();
    await expect(checkouts.resolve('b')).rejects.toThrow(/absolute/);
    await expect(checkouts.resolve(`${base}/missing`)).rejects.toThrow(/does not exist/);
  });
});

describe('grade in a named checkout', () => {
  it('grades the HEAD of the worktree of another repository', async () => {
    fresh();
    const there = await grade(host, await named(wt), 'commit', 'HEAD');
    expect((there.subject.facts['commits'] as { subject: string }[])[0]!.subject).toBe('fix(#2): in the worktree');
    const here = await grade(host, await sessionScope(), 'commit', 'HEAD');
    expect((here.subject.facts['commits'] as { subject: string }[])[0]!.subject).toBe('feat(#1): a');
  });

  it('runs the packs the checkout defines', async () => {
    fresh();
    const r = await grade(host, await named(wt), 'only-b', 'HEAD');
    expect(r.report.pack).toBe('only-b');
    await expect(grade(host, await sessionScope(), 'only-b', 'HEAD')).rejects.toThrow(/unknown pack only-b/);
  });

  it('reads a release from the checkout, its uncommitted changelog under its own root', async () => {
    fresh();
    const { subject, config } = await subjectFor(host, await named(wt), 'release', 'release');
    expect(config.release.changelog).toBe('CHANGELOG.md');
    expect(subject.facts['changelogAdded']).toContain('an unreleased line');
    expect((subject.facts['commits'] as { subject: string }[]).map((c) => c.subject)).toContain('fix(#2): in the worktree');
  });

  it('discovers rules in the checkout', async () => {
    fresh();
    const there = await subjectFor(host, await named(wt), 'rules', 'x', { text: 'a change' });
    const here = await subjectFor(host, await sessionScope(), 'rules', 'x', { text: 'a change' });
    // b carries CONTRIBUTING.md and CHANGELOG.md beside what a carries
    expect(there.subject.facts['candidates']).toBe((here.subject.facts['candidates'] as number) + 2);
  });

  it('locates in the checkout', async () => {
    fresh();
    const { subject } = await subjectFor(host, await named(wt), 'tree', 'x', { text: 'a change' });
    const paths = (subject.facts['files'] as { path: string }[]).map((f) => f.path);
    expect(paths).toContain('b.txt');
    expect(paths).not.toContain('a.txt');
  });

  it('grades a pr range from the checkout under its conventions', async () => {
    fresh();
    const { subject, config } = await subjectFor(host, await named(wt), 'pr', 'main..HEAD');
    expect(subject.facts['head']).toBe('fix/2');
    expect((subject.facts['commits'] as { message: string }[]).map((c) => c.message.split('\n')[0])).toEqual(['fix(#2): in the worktree']);
    expect(config.prs.targets).toEqual(['trunk']);
  });

  it('refuses a repo that is not the checkout, naming both', async () => {
    fresh();
    for (const kind of ['commit', 'release', 'rules', 'tree']) {
      await expect(subjectFor(host, await named(wt), kind, kind === 'release' ? 'release' : 'HEAD', { repo: 'o/a', text: kind === 'rules' || kind === 'tree' ? 't' : undefined })).rejects.toThrow(/o\/b.*o\/a/);
    }
    await expect(subjectFor(host, await named(wt), 'pr', 'main..HEAD', { repo: 'o/a' })).rejects.toThrow(/o\/b.*o\/a/);
    // without a named cwd, a commit still refuses, and a release of another repo reads the forge
    await expect(subjectFor(host, await sessionScope(), 'commit', 'HEAD', { repo: 'o/b' })).rejects.toThrow(/o\/a.*o\/b/);
    await expect(subjectFor(host, await sessionScope(), 'release', 'release', { repo: 'o/b' })).resolves.toBeDefined();
  });
});

describe('forge-only grades', () => {
  it('apply the conventions of the repository the subject is in', async () => {
    fresh({ 'o/c:.sift/config.json': JSON.stringify({ prs: { targets: ['release'] } }) });
    const other = await subjectFor(host, await sessionScope(), 'issue', '5', { repo: 'o/c' });
    expect(other.config.prs.targets).toEqual(['release']);
    const own = await subjectFor(host, await sessionScope(), 'pr', '5');
    expect(own.config.prs.targets).toEqual(['dev']);
    expect(issuesRead[0]).toBe('o/c#5');
    // a checkout named by cwd is the repository a bare number is in
    issuesRead = [];
    const there = await subjectFor(host, await named(wt), 'issue', '5');
    expect(issuesRead).toEqual(['o/b#5']);
    expect(there.config.prs.targets).toEqual(['trunk']);
  });
});

describe('the subagent default', () => {
  it('grades where the subagent was spawned, or its parent, unless cwd names another', async () => {
    fresh();
    const dirs = new SpawnDirs();
    dirs.spawned('parent', wt, undefined);
    dirs.spawned('child', undefined, 'parent');
    dirs.spawned('loose', undefined, undefined);
    const child = await scopeOf(checkouts, session, undefined, dirs.of('child'));
    expect(child).toMatchObject({ named: false, checkout: { root: wt, repo: 'o/b' } });
    expect((await scopeOf(checkouts, session, undefined, dirs.of('loose'))).checkout.root).toBe(a);
    expect((await scopeOf(checkouts, session, undefined, dirs.of(undefined))).checkout.root).toBe(a);
    expect(await scopeOf(checkouts, session, a, dirs.of('child'))).toMatchObject({ named: true, checkout: { root: a } });
    const r = await grade(host, child, 'commit', 'HEAD');
    expect((r.subject.facts['commits'] as { subject: string }[])[0]!.subject).toBe('fix(#2): in the worktree');
  });
});
