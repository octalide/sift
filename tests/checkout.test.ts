import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Forge } from '../src/forge/forge.ts';
import { gateCall } from '../src/gate/outbound.ts';
import { grade, scopeOf, SpawnDirs, subjectFor, type GradeHost, type GradeScope } from '../src/grade.ts';
import type { Judge } from '../src/judge/types.ts';
import { Checkouts, type CheckoutFs } from '../src/repo/checkout.ts';
import type { RunLike } from '../src/process.ts';
import { fakeForge } from './fake-forge.ts';
import { memoryStore, yesJudge } from './fake-source.ts';

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

// a channel both repositories define, each with its own limit
const note = (limit: number) => ({ name: 'note', tool: '^mcp__note__send$', text: { fields: ['text'] }, limit, kind: 'a note' });

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
  const repo = dir === a ? 'o/a' : dir.startsWith(b) ? 'o/b' : undefined;
  return fakeForge({ checkout: async () => (repo ? { repo, defaultBranch: 'main' } : undefined) });
};

beforeAll(() => {
  base = mkdtempSync(`${tmpdir()}/sift-checkout-`);
  a = `${base}/a`;
  b = `${base}/b`;
  wt = `${base}/b-wt`;
  mkdirSync(a);
  git(a, 'init', '-q');
  write(`${a}/.sift/config.json`, JSON.stringify({ prs: { targets: ['dev'] }, rules: { docs: ['STYLE.md'] }, outbound: { channels: [note(100)] } }));
  write(`${a}/STYLE.md`, '# Style\n\nSay it in one line.\n');
  write(`${a}/a.txt`, 'a\n');
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'feat(#1): a');

  mkdirSync(b);
  git(b, 'init', '-q');
  write(`${b}/.sift/config.json`, JSON.stringify({ prs: { targets: ['trunk'] }, release: { changelog: 'CHANGELOG.md' }, outbound: { channels: [note(5)] } }));
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

  it('refuse a pull request number given to the issue or rules pack, naming the forms each takes', async () => {
    fresh();
    const plain = fakeForge();
    host = { ...host, forge: fakeForge({ issue: async (repo, n) => ({ ...(await plain.issue(repo, n)), pr: n === 7 }) }) };
    await expect(subjectFor(host, await sessionScope(), 'issue', '7')).rejects.toThrow('issue pack: subject is o/a#7, a pull request, not an issue ("#7"); expected an issue number (N or #N) or a Fake issue URL');
    await expect(subjectFor(host, await sessionScope(), 'rules', '#7')).rejects.toThrow('rules pack: subject is o/a#7, a pull request, not an issue ("#7"); expected an issue number (N or #N), a Fake issue URL, or free text (in text)');
    // an issue number grades as before
    expect((await subjectFor(host, await sessionScope(), 'issue', '5')).subject.kind).toBe('issue');
    expect((await subjectFor(host, await sessionScope(), 'rules', '5')).subject.state).toMatchObject({ subject: { kind: 'issue', number: 5 } });
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

describe('the outbound gate', () => {
  const noRead = async (p: string): Promise<string> => {
    throw new Error(`ENOENT ${p}`);
  };

  it('judges a subagent\'s text under the checkout it was spawned in, else the session\'s', async () => {
    fresh();
    const dirs = new SpawnDirs();
    dirs.spawned('there', wt, undefined);
    dirs.spawned('loose', undefined, undefined);
    dirs.spawned('outside', base, undefined);
    const gate = async (agentId: string | undefined, text: string, tool = 'mcp__note__send') => {
      const asked: { state: unknown; instructions: string[] }[] = [];
      const { checkout } = await scopeOf(checkouts, session, undefined, dirs.of(agentId));
      const gated = await gateCall({ ...host, judge: yesJudge(0.9, asked) }, checkout, tool, tool === 'mcp__note__send' ? { text } : { content: text }, noRead);
      return { gated, rules: asked.flatMap((q) => q.instructions).filter((i) => /complies with this rule/.test(i)) };
    };

    // o/b's channel table and rule documents
    const there = await gate('there', 'ten chars.');
    expect(there.gated).toMatchObject({ outbound: { channel: 'note', limit: 5 }, decision: { allow: false, reason: 'note text is 10 chars, the limit is 5' } });
    const thereOk = await gate('there', 'ok');
    expect(thereOk.gated!.decision.allow).toBe(true);
    expect(thereOk.rules.some((r) => r.endsWith('Every commit names its issue.'))).toBe(true);
    expect(thereOk.rules.some((r) => r.endsWith('Say it in one line.'))).toBe(false);

    // the session's, from the main loop and from a subagent spawned without a cwd
    for (const agentId of [undefined, 'loose']) {
      const here = await gate(agentId, 'ten chars.');
      expect(here.gated).toMatchObject({ outbound: { channel: 'note', limit: 100 }, decision: { allow: true } });
      expect(here.rules.some((r) => r.endsWith('Say it in one line.'))).toBe(true);
      expect(here.rules.some((r) => r.endsWith('Every commit names its issue.'))).toBe(false);
    }

    // a directory in no repository: the default table, no rule documents
    expect((await gate('outside', 'ten chars.')).gated).toBeUndefined();
    const long = await gate('outside', 'x'.repeat(2001), 'mcp__discord__send_message');
    expect(long.gated!.decision).toMatchObject({ allow: false, reason: 'discord-message text is 2001 chars, the limit is 2000' });
    const outside = await gate('outside', 'hello', 'mcp__discord__send_message');
    expect(outside.gated!.decision).toMatchObject({ allow: true, reason: 'clear' });
    expect(outside.gated!.decision.report!.mechanical).toEqual([{ check: 'rules.present', severity: 'info', message: 'no rule documents found in the repo' }]);
    expect(outside.rules).toEqual([]);
  });
});
