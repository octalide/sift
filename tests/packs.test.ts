import { describe, expect, it } from 'vitest';
import type { Git } from '../src/forge/git.ts';
import { CONVENTIONAL_BUMPS, parseCommit, parseLog, requiredBump } from '../src/repo/commits.ts';
import { bumpBetween, bumpVersion, compareVersions, parseTag, parseVersion, SEMVER_PATTERN, CALVER_PATTERN } from '../src/repo/version.ts';
import { flattenManifest, manifestChanges, parseToml, parseYaml } from '../src/repo/manifest.ts';
import { driftOf, lineDiff } from '../src/repo/diff.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/repo/config.ts';
import { splitResponse } from '../src/forge/gh.ts';
import { branchIssue, commitSubject, lastReleaseTag, linkedIssues, linkedOf, planSubject, prRangeSubject, prSubject, releaseSubject, sectionsOf } from '../src/repo/subjects.ts';
import { localSource, remoteSource } from '../src/repo/source.ts';
import type { Answers, Judge } from '../src/judge/types.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { loadPacks, validatePack } from '../src/packs/load.ts';
import { formatReport, materialize, runChecks, runPack, verdictOf } from '../src/packs/run.ts';
import { fakeForge } from './fake-forge.ts';
import type { Pack, Subject } from '../src/packs/types.ts';

const answering = (answers: Answers): Judge => ({
  name: 'fake',
  ask: async () => ({ ok: true, answers, backend: 'fake', latencyMs: 1 }),
});

// a judge a mechanical pack must never reach
const unreachable: Judge = {
  name: 'unreachable',
  ask: async () => {
    throw new Error('judge called');
  },
};

describe('conventional commits', () => {
  it('parses type, scope, breaking marker and trailers', () => {
    const c = parseCommit('abc', 'feat(#12)!: add thing\n\nbody\n\nCo-Authored-By: x');
    expect(c).toMatchObject({ type: 'feat', scope: '#12', description: 'add thing', breaking: true, matched: true, trailers: ['Co-Authored-By'] });
    expect(parseCommit('d', 'random message').matched).toBe(false);
    expect(parseCommit('e', 'fix: x\n\nBREAKING CHANGE: y').breaking).toBe(true);
  });

  it('computes the required bump', () => {
    const log = parseLog('\u001eaaa\nfix: a\n\u001ebbb\nfeat: b\n\u001eccc\nchore: c\n');
    expect(requiredBump(log, CONVENTIONAL_BUMPS)).toBe('minor');
    expect(requiredBump([parseCommit('x', 'refactor!: y')], CONVENTIONAL_BUMPS)).toBe('major');
    expect(requiredBump([parseCommit('x', 'docs: y')], CONVENTIONAL_BUMPS)).toBe('none');
    expect(requiredBump([parseCommit('x', 'perf: y')], CONVENTIONAL_BUMPS)).toBe('patch');
    const v = (raw: string) => parseVersion(raw, SEMVER_PATTERN)!;
    expect(requiredBump([parseCommit('x', 'feat(#222)!: y')], CONVENTIONAL_BUMPS, v('0.17.2'))).toBe('minor');
    expect(requiredBump([parseCommit('x', 'feat(#222)!: y')], CONVENTIONAL_BUMPS, v('0.17.2'), 'major')).toBe('major');
    expect(requiredBump([parseCommit('x', 'feat(#222)!: y')], CONVENTIONAL_BUMPS, v('1.0.0'))).toBe('major');
    expect(bumpVersion(v('0.3.1'), 'minor', SEMVER_PATTERN)).toBe('0.4.0');
    expect(bumpVersion(v('1.3.1'), 'major', SEMVER_PATTERN)).toBe('2.0.0');
    expect(bumpVersion(v('1.9.9-rc.1'), 'patch', SEMVER_PATTERN)).toBe('1.9.10');
    expect(bumpBetween(v('1.2.3'), v('1.3.0'))).toBe('minor');
  });

  it('reads the bump each type calls for from the configured map', () => {
    const bumps = { change: 'minor' as const, docs: 'patch' as const, feat: 'none' as const };
    expect(requiredBump(parseLog('\u001eaaa\nfeat: a\n\u001ebbb\ndocs: b\n'), bumps)).toBe('patch');
    expect(requiredBump([parseCommit('x', 'change: y')], bumps)).toBe('minor');
    expect(requiredBump([parseCommit('x', 'feat: y')], bumps)).toBe('none');
    expect(requiredBump([parseCommit('x', 'feat!: y')], bumps)).toBe('major');
    expect(requiredBump([parseCommit('x', 'feat: y')], {})).toBe('none');
    const custom = resolveConfig({ commits: { convention: 'conventional', bumps }, release: { scheme: 'semver' } });
    expect(custom.commits.bumps).toEqual(bumps);
    expect(resolveConfig({ commits: { convention: 'conventional' } }).commits.bumps).toEqual(CONVENTIONAL_BUMPS);
    expect(resolveConfig({}).commits.bumps).toEqual(CONVENTIONAL_BUMPS);
    expect(resolveConfig({ commits: { format: String.raw`^(?<type>\w+): ` } }).commits.bumps).toEqual({});
    expect(() => resolveConfig({ commits: { bumps: { feat: 'huge' } } })).toThrow('commits.bumps.feat');
    const s: Subject = { kind: 'release', ref: 'HEAD', state: {}, facts: { has_commits: true, bump: 'none' }, options: {} };
    expect(runChecks(BUILTIN_PACKS['release']!, s, custom).map((f) => f.message)).toEqual(['nothing since the last tag calls for a release (no change, docs, breaking change, manifest change)']);
  });

  it('parses commits against a custom format', () => {
    const format = String.raw`^\[(?<type>[A-Z]+)\](?<breaking>!)? (?<description>.+)$`;
    const c = parseCommit('a', '[FIX]! crash on start', format);
    expect(c).toMatchObject({ type: 'FIX', breaking: true, matched: true, description: 'crash on start' });
    expect(c.scope).toBeUndefined();
    expect(parseCommit('b', 'fix: x', format).matched).toBe(false);
    expect(parseLog('\u001eaaa\n[FEAT] a\n', format)[0]!.type).toBe('FEAT');
  });
});

describe('versions', () => {
  it('orders versions by their numeric groups and finds the version inside a tag', () => {
    const semver = { tagPattern: '^v(?<version>.+)$', versionPattern: SEMVER_PATTERN };
    expect(parseTag('v1.2.3', semver)).toMatchObject({ raw: '1.2.3', groups: { major: '1', minor: '2', patch: '3' }, numbers: [1, 2, 3] });
    expect(parseTag('nightly', semver)).toBeUndefined();
    expect(parseTag('v1.2', semver)).toBeUndefined();
    expect(compareVersions(parseVersion('0.10.0', SEMVER_PATTERN)!, parseVersion('0.9.1', SEMVER_PATTERN)!)).toBeGreaterThan(0);
    const cal = parseVersion('2026.9.1', CALVER_PATTERN)!;
    expect(cal.numbers).toEqual([2026, 9, 1]);
    expect(compareVersions(parseVersion('2026.10', CALVER_PATTERN)!, cal)).toBeGreaterThan(0);
    expect(bumpVersion(cal, 'minor', CALVER_PATTERN)).toBeUndefined();
    expect(bumpBetween(cal, cal)).toBeUndefined();
    const release = { tagPattern: '^release-(?<version>.+)$', versionPattern: String.raw`^(?<major>\d+)\.(?<minor>\d+)$` };
    expect(parseTag('release-3.4', release)!.numbers).toEqual([3, 4]);
    expect(bumpVersion(parseTag('release-3.4', release)!, 'minor', release.versionPattern)).toBe('3.5');
    expect(bumpVersion(parseTag('release-3.4', release)!, 'patch', release.versionPattern)).toBeUndefined();
  });
});

describe('mechanical checks', () => {
  it('flags forbidden trailers, unknown types and bad scopes', () => {
    const config = resolveConfig({ commits: { convention: 'conventional', scope: 'issue', forbidTrailers: ['Co-Authored-By'] } });
    const subject: Subject = {
      kind: 'commit',
      ref: 'r',
      state: {},
      facts: { commits: [parseCommit('1234567', 'feat(auth): x\n\nCo-Authored-By: bot'), parseCommit('89abcde', 'wat: y')] },
      options: {},
    };
    const findings = runChecks(BUILTIN_PACKS['commit']!, subject, config);
    expect(findings.map((f) => f.message)).toEqual([
      '1234567 scope (auth), feat(auth) does not match ^(chore\\(.*\\)|[^(]+(\\(#\\d+\\))?)$',
      '1234567 carries forbidden trailer Co-Authored-By',
      '89abcde uses unknown type wat',
    ]);
    expect(verdictOf(findings, [], false)).toBe('fail');
  });

  it('checks nothing mechanical by default', () => {
    const subject: Subject = {
      kind: 'commit',
      ref: 'r',
      state: {},
      facts: { commits: [parseCommit('89abcde', 'wat: y')] },
      options: {},
    };
    expect(runChecks(BUILTIN_PACKS['commit']!, subject, resolveConfig(undefined))).toEqual([]);
    const version = parseVersion('1.2.3', SEMVER_PATTERN);
    const release: Subject = { kind: 'release', ref: 'HEAD', state: {}, facts: { has_commits: true, bump: 'minor', version, proposed: 'v1.2.4' }, options: {} };
    expect(runChecks(BUILTIN_PACKS['release']!, release, resolveConfig(undefined))).toEqual([]);
    const semver = runChecks(BUILTIN_PACKS['release']!, release, resolveConfig({ release: { scheme: 'semver' } }));
    expect(semver.map((f) => f.message)).toEqual(['required bump: minor, next version v1.3.0, from commits minor', 'v1.2.4 is a patch bump, the changes require minor']);
  });

  it('checks a calver release for order, not for a bump', () => {
    const config = resolveConfig({ release: { scheme: 'calver' } });
    const version = parseVersion('2026.8.2', CALVER_PATTERN);
    const at = (proposed: string): Subject => ({ kind: 'release', ref: 'HEAD', state: {}, facts: { has_commits: true, bump: 'minor', version, proposed }, options: {} });
    expect(runChecks(BUILTIN_PACKS['release']!, at('v2026.9'), config).map((f) => f.message)).toEqual(['required bump: minor, from commits minor']);
    expect(runChecks(BUILTIN_PACKS['release']!, at('v2026.8.1'), config).map((f) => f.message)).toEqual(['required bump: minor, from commits minor', 'v2026.8.1 is not newer than 2026.8.2']);
    expect(runChecks(BUILTIN_PACKS['release']!, at('v1.2.3'), config).map((f) => f.message)[1]).toBe(`v1.2.3 does not match the version pattern ${CALVER_PATTERN}`);
  });

  it('reads the resolved regexes, whichever way they were configured', () => {
    const commit = (config: unknown, message: string) => runChecks(BUILTIN_PACKS['commit']!, { kind: 'commit', ref: 'r', state: {}, facts: { commits: [parseCommit('1234567', message, resolveConfig(config).commits.format)] }, options: {} }, resolveConfig(config)).map((f) => f.message);
    const format = String.raw`^(?<type>[A-Z]+)-(?<scope>\d+): (?<description>.+)$`;
    expect(commit({ commits: { format, types: ['FIX'], scopePattern: String.raw`^FIX\(\d+\)$` } }, 'FIX-12: crash')).toEqual([]);
    expect(commit({ commits: { format, types: ['FIX'], scopePattern: String.raw`^FIX\(\d+\)$` } }, 'fix(#12): crash')).toEqual(['1234567 does not match the commit format: fix(#12): crash']);
    expect(commit({ commits: { convention: 'conventional', scope: 'none' } }, 'fix(#12): crash')).toEqual(['1234567 scope (#12), fix(#12) does not match ^[^(]*$']);
    expect(commit({ commits: { convention: 'conventional', scope: 'issue' } }, 'chore(release): 0.9.1')).toEqual([]);
    expect(commit({ commits: { convention: 'conventional', scope: 'issue' } }, 'chore: tidy')).toEqual([]);
    expect(commit({ commits: { convention: 'none', format: String.raw`^(?<type>\w+): ` } }, 'wat: y')).toEqual(['1234567 uses unknown type wat']);
    const pr = (targets: unknown, base: string) => runChecks(BUILTIN_PACKS['pr']!, { kind: 'pr', ref: 'r', state: {}, facts: { base, linked: [1] }, options: {} }, resolveConfig({ prs: targets })).map((f) => f.message);
    expect(pr({ target: 'dev' }, 'dev')).toEqual([]);
    expect(pr({ target: 'dev' }, 'main')).toEqual(['targets main, expected dev']);
    expect(pr({ targets: ['dev', 'main'] }, 'main')).toEqual([]);
    expect(pr({ targets: '^release/' }, 'release/1.0')).toEqual([]);
    expect(pr({ targets: '^release/' }, 'dev')).toEqual(['targets dev, expected a branch matching ^release/']);
  });

  it('expands presets and lets an explicit pattern override them', () => {
    const preset = resolveConfig({ commits: { convention: 'conventional', scope: 'issue' }, release: { scheme: 'semver', tagPrefix: 'rel.' } });
    expect(preset.commits.format).toBe(String.raw`^(?<type>\w+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s+(?<description>.+)$`);
    expect(preset.commits.scopePattern).toBe(String.raw`^(chore\(.*\)|[^(]+(\(#\d+\))?)$`);
    expect(preset.release.versionPattern).toBe(SEMVER_PATTERN);
    expect(preset.release.tagPattern).toBe(String.raw`^rel\.(?<version>.+)$`);
    const explicit = resolveConfig({ commits: { convention: 'conventional', format: '^x$', scope: 'issue', scopePattern: '^y$' }, release: { scheme: 'calver', versionPattern: '^z$', tagPattern: '^w$' } });
    expect(explicit.commits).toMatchObject({ format: '^x$', scopePattern: '^y$' });
    expect(explicit.release).toMatchObject({ versionPattern: '^z$', tagPattern: '^w$' });
    const off = resolveConfig(undefined);
    expect(off.commits.format).toBeUndefined();
    expect(off.commits.scopePattern).toBeUndefined();
    expect(off.release.versionPattern).toBeUndefined();
    expect(off.release.tagPattern).toBe('^v(?<version>.+)$');
    expect(() => resolveConfig({ branches: { pattern: '(' } })).toThrow('branches.pattern is not a valid regex');
    // this repo's own .sift/config.json, which must keep resolving to the presets it names
    const own = resolveConfig({
      commits: { convention: 'conventional', scope: 'issue', forbidTrailers: ['Co-Authored-By'] },
      branches: { protected: ['main', 'dev'], pattern: '^(feat|fix|chore|hotfix)/\\d+$' },
      prs: { linkIssue: false, target: 'dev' },
    });
    expect(own.commits).toMatchObject({ format: preset.commits.format, scopePattern: preset.commits.scopePattern, forbidTrailers: ['Co-Authored-By'] });
    expect(own.prs.targets).toEqual(['dev']);
    expect(own.branches.pattern).toBe('^(feat|fix|chore|hotfix)/\\d+$');
  });

  it('reads dependency floors out of a manifest and names the changed keys', () => {
    const before = '[project]\nid = "hedge"\nversion = "0.7.0"\nmach = "^5.3"\n\n[dep.std]\ngit = "https://x/std"\nref = "tag/v5.7.0"\n';
    const after = '[project]\nid = "hedge"\nversion = "0.7.1"\nmach = "^5.9" # floor\n\n[dep.std]\ngit = "https://x/std"\nref = "tag/v6.0.0"\n\n[dep.tls]\ngit = "https://x/tls"\nref = "tag/v0.8.1"\n';
    expect(flattenManifest(parseToml(after))['project.mach']).toBe('"^5.9"');
    const rule = { path: 'mach.toml', keys: ['^project\\.mach$', '^dep\\.[^.]+\\.(git|ref)$'], bump: 'minor' as const };
    const changes = manifestChanges(rule, before, after);
    expect(changes.map((c) => `${c.key} ${c.from} -> ${c.to}`)).toEqual(['project.mach "^5.3" -> "^5.9"', 'dep.std.ref "tag/v5.7.0" -> "tag/v6.0.0"', 'dep.tls.git null -> "https://x/tls"', 'dep.tls.ref null -> "tag/v0.8.1"']);
    expect(manifestChanges(rule, before, before)).toEqual([]);
    const release: Subject = {
      kind: 'release',
      ref: 'HEAD',
      state: {},
      facts: { has_commits: true, bump: 'minor', commitBump: 'none', manifestBump: 'minor', manifests: changes.slice(0, 1), version: parseVersion('0.7.0', SEMVER_PATTERN) },
      options: {},
    };
    const findings = runChecks(BUILTIN_PACKS['release']!, release, resolveConfig({ release: { scheme: 'semver' } }));
    expect(findings.map((f) => f.message)).toEqual(['required bump: minor, next version v0.8.0, from mach.toml project.mach "^5.3" -> "^5.9" (minor)']);
  });

  it('parses the toml a manifest needs: arrays of tables, inline values, multi-line arrays, quoted keys', () => {
    const toml = [
      'title = "x" # c',
      'nums = [1, 2,',
      '  3] # trailing',
      'inline = { a = "b", c.d = true }',
      '"dotted.key" = \'lit # not a comment\'',
      'when = 1979-05-27T07:32:00Z',
      '[[dep]]',
      'name = "std"',
      '[dep.opts]',
      'strict = false',
      '[[dep]]',
      'name = "tls"',
    ].join('\n');
    expect(flattenManifest(parseToml(toml))).toEqual({
      title: '"x"',
      'nums.0': '1',
      'nums.1': '2',
      'nums.2': '3',
      'inline.a': '"b"',
      'inline.c.d': 'true',
      'dotted.key': '"lit # not a comment"',
      when: '"1979-05-27T07:32:00Z"',
      'dep.0.name': '"std"',
      'dep.0.opts.strict': 'false',
      'dep.1.name': '"tls"',
    });
  });

  it('parses the yaml a manifest needs: nested maps, sequences of maps, flow values, block scalars', () => {
    const yaml = [
      '# pubspec',
      'name: hedge',
      'version: "1.2.0"',
      'environment:',
      '  sdk: ">=3.0.0 <4.0.0"',
      'dependencies:',
      '  http: ^1.1.0',
      '  path:',
      '    git:',
      '      url: https://x/path # comment',
      '      ref: v1',
      'tags: [a, "b, c"]',
      'authors:',
      '  - name: one',
      '    email: one@x',
      '  - two',
      'notes: |',
      '  first',
      '  second',
      'empty: {}',
    ].join('\n');
    expect(flattenManifest(parseYaml(yaml))).toEqual({
      name: '"hedge"',
      version: '"1.2.0"',
      'environment.sdk': '">=3.0.0 <4.0.0"',
      'dependencies.http': '"^1.1.0"',
      'dependencies.path.git.url': '"https://x/path"',
      'dependencies.path.git.ref': '"v1"',
      'tags.0': '"a"',
      'tags.1': '"b, c"',
      'authors.0.name': '"one"',
      'authors.0.email': '"one@x"',
      'authors.1': '"two"',
      notes: '"first\\nsecond\\n"',
      empty: '{}',
    });
  });

  it('diffs manifest keys in json and yaml the same way as toml, arrays by index', () => {
    const rule = { path: 'package.json', keys: ['^dependencies\\.', '^files\\.\\d+$'], bump: 'patch' as const };
    const before = JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { a: '^1' }, files: ['lib'] });
    const after = JSON.stringify({ name: 'x', version: '1.0.1', dependencies: { a: '^2', b: '^1' }, files: ['lib', 'bin'] });
    expect(manifestChanges(rule, before, after).map((c) => `${c.key} ${c.from} -> ${c.to}`)).toEqual(['dependencies.a "^1" -> "^2"', 'dependencies.b null -> "^1"', 'files.1 null -> "bin"']);
    const yamlRule = { path: 'pubspec.yaml', keys: ['^environment\\.sdk$'], bump: 'minor' as const };
    expect(manifestChanges(yamlRule, 'environment:\n  sdk: ">=3.0.0"\n', 'environment:\n  sdk: ">=3.2.0"\n').map((c) => c.key)).toEqual(['environment.sdk']);
    expect(manifestChanges(yamlRule, 'environment:\n  sdk: ">=3.0.0"\n', 'environment:\n  sdk: ">=3.0.0"\nname: y\n')).toEqual([]);
  });

  it('matches a pattern over the text of any manifest and reports the matched text', () => {
    const rule = { path: 'Makefile', pattern: '^ABI_VERSION\\s*=\\s*\\S+', bump: 'major' as const };
    const before = 'CC = gcc\nABI_VERSION = 3\n';
    const after = 'CC = clang\nABI_VERSION = 4\n';
    expect(manifestChanges(rule, before, after)).toEqual([{ path: 'Makefile', key: '/^ABI_VERSION\\s*=\\s*\\S+/', from: 'ABI_VERSION = 3', to: 'ABI_VERSION = 4', bump: 'major' }]);
    expect(manifestChanges(rule, before, before.replace('gcc', 'clang'))).toEqual([]);
    expect(manifestChanges(rule, undefined, after).map((c) => c.from)).toEqual([null]);
    const both = { path: 'mach.toml', keys: ['^project\\.mach$'], pattern: '^# abi \\d+', bump: 'minor' as const };
    expect(manifestChanges(both, '# abi 1\n[project]\nmach = "^5"\n', '# abi 2\n[project]\nmach = "^6"\n').map((c) => c.key)).toEqual(['project.mach', '/^# abi \\d+/']);
  });

  it('warns when keys are given for a manifest in no parsed format', () => {
    const release: Subject = {
      kind: 'release',
      ref: 'HEAD',
      state: {},
      facts: { has_commits: true, bump: 'minor', commitBump: 'minor', manifests: [], manifestsUnparsed: ['Makefile'], version: parseVersion('1.0.0', SEMVER_PATTERN) },
      options: {},
    };
    const findings = runChecks(BUILTIN_PACKS['release']!, release, resolveConfig({ release: { scheme: 'semver' } }));
    expect(findings.map((f) => `${f.severity} ${f.message}`)).toEqual(['warn Makefile is not toml, json or yaml, its keys match nothing (use pattern)', 'info required bump: minor, next version v1.1.0, from commits minor']);
  });

  it('diffs lines, skipping the common ends', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nb\nc')).toEqual({ added: ['x'], removed: [], text: '+x' });
    expect(lineDiff('a\nb', 'a\nc')).toEqual({ added: ['c'], removed: ['b'], text: '-b\n+c' });
    expect(lineDiff('', 'a')).toEqual({ added: ['a'], removed: [], text: '+a' });
    expect(lineDiff('same', 'same')).toEqual({ added: [], removed: [], text: '' });
  });

  it('flags an unchanged changelog and asks about the added text only when there is some', () => {
    const config = resolveConfig({ release: { scheme: 'semver', changelog: 'CHANGELOG.md' } });
    const facts = { has_commits: true, bump: 'minor', commitBump: 'minor', manifests: [], version: [1, 0, 0], lastTag: 'v1.0.0' };
    const same: Subject = { kind: 'release', ref: 'HEAD', state: {}, facts: { ...facts, changelogPath: 'CHANGELOG.md', changelog_changed: false }, options: {} };
    expect(runChecks(BUILTIN_PACKS['release']!, same, config).filter((f) => f.check === 'release.changelog').map((f) => f.message)).toEqual(['CHANGELOG.md is unchanged since v1.0.0']);
    const missing: Subject = { ...same, facts: { ...facts } };
    expect(runChecks(BUILTIN_PACKS['release']!, missing, config).filter((f) => f.check === 'release.changelog').map((f) => f.message)).toEqual(['CHANGELOG.md not found']);
    const grown: Subject = { ...same, facts: { ...facts, changelogPath: 'CHANGELOG.md', changelog_changed: true } };
    expect(runChecks(BUILTIN_PACKS['release']!, grown, config).filter((f) => f.check === 'release.changelog')).toEqual([]);
    expect(BUILTIN_PACKS['release']!.questions['changelog_complete']!.when).toBe('changelog_changed');
  });

  it('asks a large pack in several requests and keeps every answer', async () => {
    const asks: number[] = [];
    const judge: Judge = {
      name: 'fake',
      ask: async (_s, q) => {
        asks.push(Object.keys(q).length);
        return { ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'noul' as const, p: 0.9 }])) };
      },
    };
    const rules = Array.from({ length: 900 }, (_, i) => ({ source: 'd', text: `rule ${i} ${'x'.repeat(200)}` }));
    const subject: Subject = { kind: 'rules', ref: 't', state: {}, facts: { rules, has_rules: true, total_rules: 900, docs: ['d'] }, options: {} };
    const report = await runPack(BUILTIN_PACKS['rules']!, subject, judge, resolveConfig({ rules: { maxRules: 900 } }));
    expect(asks.length).toBeGreaterThan(1);
    expect(asks.reduce((a, b) => a + b, 0)).toBe(900);
    expect(report.judged).toEqual([]);
    expect(report.ranked[0]!.items).toHaveLength(900);
    expect(report.mechanical).toEqual([{ check: 'rules.present', severity: 'info', message: '900 rules from d' }]);
    const capped = runChecks(BUILTIN_PACKS['rules']!, { ...subject, facts: { ...subject.facts, total_rules: 900 } }, resolveConfig(undefined));
    expect(capped.map((f) => f.message)).toEqual(['200 rules from d', '200 of 900 rules used, raise rules.maxRules to judge the rest']);
  });

  it('layers config sources in order', () => {
    const config = resolveConfig([{ commits: { convention: 'conventional', scope: 'issue' }, prs: { target: 'dev' } }, { commits: { scope: 'any' } }], 'main');
    expect(config.commits).toMatchObject({ convention: 'conventional', scope: 'any' });
    expect(config.commits.scopePattern).toBeUndefined();
    expect(config.prs.targets).toEqual(['dev']);
    expect(config.branches.protected).toEqual(['main']);
  });

  it('requires label groups and milestones only when configured', async () => {
    const config = resolveConfig({ issues: { requiredLabelGroups: [['bug', 'feat']], milestone: true, templateSections: ['Summary'] } });
    const subject: Subject = {
      kind: 'issue',
      ref: 'r#1',
      state: {},
      facts: { labels: ['docs'], sections: { Summary: '<!-- fill me -->' }, has_others: false },
      options: {},
    };
    const report = await runPack(BUILTIN_PACKS['issue']!, subject, answering({ substantive: { type: 'noul', p: 0.9 }, single_repo: { type: 'noul', p: 0.9 }, needs_parent: { type: 'noul', p: 0.1 }, readiness: { type: 'score', score: 2, expected: 2, legend: 'ready', probabilities: [0, 0, 1], confidence: 1 } }), config);
    const checks = report.mechanical.map((f) => `${f.check}:${f.severity}`);
    expect(checks).toContain('issue.labels:fail');
    expect(checks).toContain('issue.milestone:fail');
    expect(checks).toContain('issue.template:warn');
    expect(report.verdict).toBe('fail');
    expect(report.mechanical.some((f) => f.check === 'issue.labels')).toBe(true);
    expect(resolveConfig(undefined, 'main').branches.protected).toEqual(['main']);
    expect(DEFAULT_CONFIG.issues.milestone).toBe(false);
  });
});

describe('issue pack', () => {
  it('fails an issue that leaves a decision open and warns on unbounded scope', async () => {
    const subject: Subject = { kind: 'issue', ref: 'r#1', state: {}, facts: { labels: [], sections: {}, has_others: false }, options: {} };
    const ready = { substantive: { type: 'noul' as const, p: 0.9 }, single_repo: { type: 'noul' as const, p: 0.9 }, needs_parent: { type: 'noul' as const, p: 0.1 }, readiness: { type: 'score' as const, score: 2, expected: 2, legend: 'ready', probabilities: [0, 0, 1], confidence: 1 } };
    const config = resolveConfig(undefined);
    const open = await runPack(BUILTIN_PACKS['issue']!, subject, answering({ ...ready, implementable: { type: 'noul', p: 0.1 }, scope_clear: { type: 'noul', p: 0.9 } }), config);
    expect(open.verdict).toBe('fail');
    expect(open.judged.find((j) => j.id === 'implementable')).toMatchObject({ band: 'violated', severity: 'fail' });
    const loose = await runPack(BUILTIN_PACKS['issue']!, subject, answering({ ...ready, implementable: { type: 'noul', p: 0.9 }, scope_clear: { type: 'noul', p: 0.1 } }), config);
    expect(loose.verdict).toBe('warn');
    expect(loose.judged.find((j) => j.id === 'scope_clear')).toMatchObject({ band: 'violated', severity: 'warn' });
    const clear = await runPack(BUILTIN_PACKS['issue']!, subject, answering({ ...ready, implementable: { type: 'noul', p: 0.9 }, scope_clear: { type: 'noul', p: 0.9 } }), config);
    expect(clear.verdict).toBe('pass');
  });

  it('shows needs_parent satisfied for an issue with no parent, and readiness banded on the level it picked', async () => {
    const subject: Subject = { kind: 'issue', ref: 'r#1', state: {}, facts: { labels: [], sections: {}, has_others: false }, options: {} };
    const config = resolveConfig(undefined);
    const clean = { substantive: { type: 'noul' as const, p: 0.9 }, implementable: { type: 'noul' as const, p: 0.9 }, scope_clear: { type: 'noul' as const, p: 0.9 }, single_repo: { type: 'noul' as const, p: 0.9 } };
    const level = (score: number, confidence: number) => ({ type: 'score' as const, score, expected: score, legend: String(score), probabilities: [0, 0, 0].map((_, i) => (i === score ? confidence : (1 - confidence) / 2)), confidence });
    const grade = (parent: number, readiness: ReturnType<typeof level>) => runPack(BUILTIN_PACKS['issue']!, subject, answering({ ...clean, needs_parent: { type: 'noul', p: parent }, readiness }), config);
    const band = (r: Awaited<ReturnType<typeof grade>>, id: string) => r.judged.find((j) => j.id === id)!.band;
    const alone = await grade(0.23, level(2, 0.97));
    expect(band(alone, 'needs_parent')).toBe('satisfied');
    expect(band(alone, 'readiness')).toBe('satisfied');
    expect(alone.verdict).toBe('pass');
    expect(band(await grade(0.9, level(2, 0.97)), 'needs_parent')).toBe('violated');
    for (const picked of [0, 1, 2]) expect(band(await grade(0.23, level(picked, 0.4)), 'readiness')).toBe('unclear');
    const triage = await grade(0.23, level(1, 0.9));
    expect(triage.judged.find((j) => j.id === 'readiness')).toMatchObject({ band: 'violated', severity: 'info' });
    expect(triage.verdict).toBe('pass');
  });

  it('bands a repo pack score on the level it picked, so only a confident violating level fails', async () => {
    const pack: Pack = { name: 'p', subject: 'text', description: 'x', checks: [], questions: { fit: { type: 'score', instructions: 'x', criteria: ['bad', 'fine', 'good'], violates: [0], severity: 'fail' } } };
    const subject: Subject = { kind: 'text', ref: 'x', state: {}, facts: {}, options: {} };
    const config = resolveConfig(undefined);
    const grade = (score: number, confidence: number) => runPack(pack, subject, answering({ fit: { type: 'score', score, expected: score, legend: String(score), probabilities: [], confidence } }), config);
    for (const picked of [0, 1, 2]) {
      const unsure = await grade(picked, 0.2);
      expect(unsure.judged[0]!.band).toBe('unclear');
      expect(unsure.verdict).toBe('warn');
    }
    const bad = await grade(0, 0.9);
    expect(bad.judged[0]!.band).toBe('violated');
    expect(bad.verdict).toBe('fail');
    for (const picked of [1, 2]) {
      const fine = await grade(picked, 0.9);
      expect(fine.judged[0]!.band).toBe('satisfied');
      expect(fine.verdict).toBe('pass');
    }
  });

  it('never counts duplicate_of = none as a finding, and warns only on a confident duplicate', async () => {
    const subject: Subject = { kind: 'issue', ref: 'r#1', state: {}, facts: { labels: [], sections: {}, has_others: true }, options: { open_issues: { '#3': 'three', '#4': 'four' } } };
    const config = resolveConfig(undefined);
    const clean = { substantive: { type: 'noul' as const, p: 0.9 }, implementable: { type: 'noul' as const, p: 0.9 }, scope_clear: { type: 'noul' as const, p: 0.9 }, single_repo: { type: 'noul' as const, p: 0.9 } };
    const pick = (choice: string, confidence: number) => ({ type: 'choice' as const, choice, probabilities: { [choice]: confidence }, confidence });
    const grade = (duplicate: ReturnType<typeof pick>) => runPack(BUILTIN_PACKS['issue']!, subject, answering({ ...clean, duplicate_of: duplicate, blocked_by: pick('none', 1) }), config);
    for (const confidence of [0.16, 0.32, 0.5, 0.99]) {
      const none = await grade(pick('none', confidence));
      expect(none.verdict).toBe('pass');
      expect(none.judged.find((j) => j.id === 'duplicate_of')!.band).toBe(confidence >= 0.7 ? 'satisfied' : 'unclear');
    }
    const duplicate = await grade(pick('#3', 0.9));
    expect(duplicate.verdict).toBe('warn');
    expect(duplicate.judged.find((j) => j.id === 'duplicate_of')).toMatchObject({ band: 'violated', severity: 'warn' });
    for (const confidence of [0.16, 0.5]) {
      const unsure = await grade(pick('#3', confidence));
      expect(unsure.verdict).toBe('pass');
      expect(unsure.judged.find((j) => j.id === 'duplicate_of')!.band).toBe('unclear');
    }
  });
});

describe('pack materialization', () => {
  it('skips when-gated questions, fills runtime options, and expands rules', () => {
    const subject: Subject = { kind: 'issue', ref: 'x', state: {}, facts: { has_others: true }, options: { open_issues: { '#3': 'three' }, type_labels: {} } };
    const { questions } = materialize(BUILTIN_PACKS['issue']!, subject);
    expect(questions['duplicate_of']).toMatchObject({ type: 'choice', criteria: { '#3': 'three', none: expect.any(String) } });
    expect(questions['blocked_by']).toMatchObject({ type: 'choice', criteria: { '#3': 'three', none: expect.any(String) } });
    expect(questions['type']).toBeUndefined();
    const alone = materialize(BUILTIN_PACKS['issue']!, { ...subject, facts: { has_others: false } });
    expect(alone.questions['blocked_by']).toBeUndefined();
    expect(alone.questions['duplicate_of']).toBeUndefined();
    const rules: Subject = { kind: 'rules', ref: 'x', state: {}, facts: { rules: [{ text: 'no em dashes' }, { text: 'tests pass' }] }, options: {} };
    const expanded = materialize(BUILTIN_PACKS['rules']!, rules);
    expect(expanded.questions).toEqual({});
    expect(expanded.steps[0]!.items).toHaveLength(2);
    expect(expanded.steps[0]!.questions['rules']!.instructions).toBe('The subject complies with this rule: {text}');
  });

  it('inverts bad-outcome nouls and grades the verdict', async () => {
    const pack: Pack = {
      name: 'bands',
      subject: 'text',
      description: '',
      checks: [],
      questions: {
        does_it: { type: 'noul', instructions: 'x', severity: 'fail' },
        creeps: { type: 'noul', instructions: 'x', inverted: true, severity: 'warn' },
        patches: { type: 'noul', instructions: 'x', inverted: true, severity: 'warn' },
        breaks: { type: 'noul', instructions: 'x', inverted: true, severity: 'info' },
      },
    };
    const subject: Subject = { kind: 'text', ref: 't', state: {}, facts: {}, options: {} };
    const report = await runPack(
      pack,
      subject,
      answering({ does_it: { type: 'noul', p: 0.95 }, creeps: { type: 'noul', p: 0.9 }, patches: { type: 'noul', p: 0.1 }, breaks: { type: 'noul', p: 0.5 } }),
      DEFAULT_CONFIG,
    );
    const bands = Object.fromEntries(report.judged.map((j) => [j.id, j.band]));
    expect(bands).toMatchObject({ does_it: 'satisfied', creeps: 'violated', patches: 'satisfied', breaks: 'unclear' });
    expect(report.verdict).toBe('warn');
  });

  it('reports unknown when the judge is unavailable and validates pack files', async () => {
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'off' }) };
    const report = await runPack(BUILTIN_PACKS['plan']!, { kind: 'plan', ref: 'p', state: {}, facts: {}, options: {} }, off, DEFAULT_CONFIG);
    expect(report.verdict).toBe('unknown');
    expect(() => validatePack({ subject: 'issue', questions: { q: { type: 'nope', instructions: 'x' } } }, 'bad')).toThrow(/unknown type/);
    expect(validatePack({ subject: 'text', questions: { q: { type: 'noul', instructions: 'x' } } }, 'ok').name).toBe('ok');
    expect(() => validatePack({ subject: 'text', questions: { q: { type: 'noul', instructions: 'x', criteria: 'prose' } } }, 'bad')).toThrow(/true, false/);
    expect(validatePack({ subject: 'text', questions: { q: { type: 'noul', instructions: 'x', criteria: { true: 'yes', false: 'no' } } } }, 'ok').name).toBe('ok');
    expect(() => validatePack({ subject: 'text', questions: { q: { type: 'noul', instructions: 'x', violates: ['a'] } } }, 'bad')).toThrow(/needs a choice/);
    expect(() => validatePack({ subject: 'text', questions: { q: { type: 'choice', instructions: 'x', criteria: { a: 'a' }, violates: 'listed' } } }, 'bad')).toThrow(/listed with options/);
    expect(() => validatePack({ subject: 'text', questions: { q: { type: 'choice', instructions: 'x', criteria: { a: 'a' }, violates: 'a' } } }, 'bad')).toThrow(/list of option keys/);
    expect(validatePack({ subject: 'text', questions: { q: { type: 'choice', instructions: 'x', criteria: { a: 'a' }, violates: ['a'] } } }, 'ok').name).toBe('ok');
    expect(validatePack({ subject: 'issue', questions: { q: { type: 'choice', instructions: 'x', options: 'open_issues', violates: 'listed' } } }, 'ok').name).toBe('ok');
    expect(validatePack({ subject: 'text', questions: { q: { type: 'score', instructions: 'x', criteria: ['a', 'b'], violates: [0] } } }, 'ok').name).toBe('ok');
    expect(() => validatePack({ subject: 'text', questions: { q: { type: 'score', instructions: 'x', criteria: ['a', 'b'], violates: [2] } } }, 'bad')).toThrow(/level indices/);
    expect(() => validatePack({ subject: 'text', questions: { q: { type: 'score', instructions: 'x', criteria: ['a', 'b'], violates: ['a'] } } }, 'bad')).toThrow(/level indices/);
    expect(() => validatePack({ subject: 'text', questions: { q: { type: 'score', instructions: 'x', criteria: ['a', 'b'], violates: 'listed' } } }, 'bad')).toThrow(/level indices/);
  });
  it('drops an answer to a question it did not ask and reports the count without touching the verdict', async () => {
    // answers every question asked at 0.9 and one nobody asked, for the pack and for the rank step
    const judge: Judge = {
      name: 'fake',
      ask: async (_state, questions) => ({
        ok: true,
        answers: { ...Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', p: 0.9 }])), unasked: { type: 'noul', p: 0.9 } },
        backend: 'fake',
        latencyMs: 1,
      }),
    };
    const pack: Pack = {
      name: 'both',
      subject: 'text',
      description: '',
      checks: [],
      questions: { creeps: { type: 'noul', instructions: 'x', inverted: true } },
      rank: [{ from: 'files', label: 'path', list: 'each', questions: { collides: { type: 'noul', instructions: '{path} collides', inverted: true } } }],
    };
    const s: Subject = { kind: 'text', ref: 'p', state: {}, facts: { files: [{ path: 'y.ts' }] }, options: {} };
    const report = await runPack(pack, s, judge, DEFAULT_CONFIG);
    expect(report.judged.map((j) => j.id)).not.toContain('unasked');
    expect(report.ranked[0]!.items).toHaveLength(1);
    expect(report.dropped).toBe(2);
    expect(report.judgeError).toBeUndefined();
    expect(report.verdict).toBe('warn');
    expect(formatReport(report)).toContain('2 answers dropped: unasked or missing');
    const exact: Judge = { name: 'fake', ask: async (_state, questions) => ({ ok: true, answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', p: 0.9 }])), backend: 'fake', latencyMs: 1 }) };
    const clean = await runPack(pack, s, exact, DEFAULT_CONFIG);
    expect(clean.dropped).toBeUndefined();
  });

  it('bands a rank item the judge left without its by answer unclear and counts it dropped', async () => {
    // answers every question asked at 0.9, except the by question of the second ranked item
    const judge: Judge = {
      name: 'fake',
      ask: async (_state, questions) => ({
        ok: true,
        answers: Object.fromEntries(Object.keys(questions).filter((id) => id !== 'rules_1').map((id) => [id, { type: 'noul', p: 0.9 }])),
        backend: 'fake',
        latencyMs: 1,
      }),
    };
    const s: Subject = { kind: 'rules', ref: 'x', state: {}, facts: { rules: [{ text: 'no em dashes' }, { text: 'tests pass' }, { text: 'no semicolons' }] }, options: {} };
    const report = await runPack(BUILTIN_PACKS['rules']!, s, judge, DEFAULT_CONFIG);
    expect(report.judgeError).toBeUndefined();
    expect(report.ranked[0]!.items.map((j) => j.band)).toEqual(['satisfied', 'unclear', 'satisfied']);
    expect(report.ranked[0]!.items[1]!.answer).toBeUndefined();
    expect(report.ranked[0]!.kept).toBe(3);
    expect(report.dropped).toBe(1);
    expect(formatReport(report)).toContain('unanswered');
    expect(formatReport(report)).toContain('1 answer dropped: unasked or missing');
  });

  it('reads a plan beside its issue and warns, never fails, on an unasked decision', async () => {
    const forge = fakeForge({ issue: async (_r, n) => ({ ...(await fakeForge().issue('o/r', n)), title: 'watch: name the agent per ref', body: 'Arm the watch with a ref, deliver ci settled to the agent that armed it.' }) });
    // the two plans of PR #120: the first lists its implementation choices, the second dropped them to satisfy the grader
    const decided = 'arm stores {agent, ref}, a leading # on the ref is stripped once, a later arm on the same ref replaces the entry, and the arming notice names the ref';
    const literal = 'arm stores {agent, ref}, the ref is compared as given and nothing is parsed from it';
    const s = await planSubject(forge, 'o/r', 119, decided);
    expect(s.kind).toBe('plan');
    expect(s.ref).toBe('o/r#119');
    expect(s.state).toMatchObject({ number: 119, issue: { title: 'watch: name the agent per ref' }, plan: decided });
    expect(s.facts['has_plan']).toBe(true);
    expect(BUILTIN_PACKS['plan']!.checks).toEqual([]);
    const first = await runPack(
      BUILTIN_PACKS['plan']!,
      s,
      answering({ covers: { type: 'noul', p: 0.86 }, adds_nothing: { type: 'noul', p: 0.1 }, decides_unasked: { type: 'noul', p: 0.75 } }),
      DEFAULT_CONFIG,
    );
    expect(Object.fromEntries(first.judged.map((j) => [j.id, j.band]))).toEqual({ covers: 'satisfied', adds_nothing: 'satisfied', decides_unasked: 'violated' });
    expect(first.judged.find((j) => j.id === 'decides_unasked')).toMatchObject({ severity: 'warn' });
    expect(first.verdict).toBe('warn');
    const second = await runPack(
      BUILTIN_PACKS['plan']!,
      await planSubject(forge, 'o/r', 119, literal),
      answering({ covers: { type: 'noul', p: 0.85 }, adds_nothing: { type: 'noul', p: 0.1 }, decides_unasked: { type: 'noul', p: 0.6 } }),
      DEFAULT_CONFIG,
    );
    expect(second.judged.find((j) => j.id === 'decides_unasked')).toMatchObject({ band: 'unclear', severity: 'warn' });
    expect(second.verdict).toBe('pass');
    const missing = await runPack(
      BUILTIN_PACKS['plan']!,
      s,
      answering({ covers: { type: 'noul', p: 0.2 }, adds_nothing: { type: 'noul', p: 0.1 }, decides_unasked: { type: 'noul', p: 0.1 } }),
      DEFAULT_CONFIG,
    );
    expect(missing.verdict).toBe('fail');
  });
});

describe('github helpers', () => {
  it('splits gh api -i output with pagination', () => {
    const raw = 'HTTP/2.0 200 OK\r\nEtag: "a"\r\nX-Ratelimit-Remaining: 4999\r\n\r\n[{"n":1}]\nHTTP/2.0 200 OK\r\nEtag: "b"\r\n\r\n[{"n":2}]\n';
    const r = splitResponse(raw);
    expect(r.status).toBe(200);
    expect(r.etag).toBe('"a"');
    expect(r.remaining).toBe(4999);
    expect(JSON.parse(r.body)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(splitResponse('HTTP/2.0 304 Not Modified\r\nEtag: "a"\r\n\r\n').status).toBe(304);
  });

  it('picks the highest semver tag, not the nearest ancestor', () => {
    const release = resolveConfig(undefined).release;
    expect(lastReleaseTag(['v0.3.4', 'v0.10.0', 'v0.9.1', 'nightly'], release)?.tag).toBe('v0.10.0');
    expect(lastReleaseTag([], release)).toBeUndefined();
    const cal = resolveConfig({ release: { scheme: 'calver', tagPattern: '^(?<version>\\d{4}\\..+)$' } }).release;
    expect(lastReleaseTag(['2026.9', '2025.12.3', 'v1.0.0'], cal)?.tag).toBe('2026.9');
  });

  it('drops merge commits from a pull request before the convention judges them', async () => {
    const forge = fakeForge({
      pull: async (_r, n) => ({ ...(await fakeForge().pull('o/r', n)), body: 'Closes #1', base: 'dev', head: { branch: 'perf/1', sha: 'h' } }),
      pullCommits: async () => [
        { sha: 'a'.repeat(40), message: 'perf(#1): faster', merge: false },
        { sha: 'b'.repeat(40), message: "Merge remote-tracking branch 'origin/dev' into perf/1", merge: true },
      ],
      diff: async () => 'diff',
    });
    const s = await prSubject(forge, 'o/r', 7, DEFAULT_CONFIG);
    expect((s.facts['commits'] as { message: string }[]).map((c) => c.message)).toEqual(['perf(#1): faster']);
    expect((s.state as { commits: string[] }).commits).toEqual(['perf(#1): faster']);
    expect(s.facts['linked']).toEqual([1]);
    expect(s.facts['has_issue']).toBe(true);
    expect(runChecks(BUILTIN_PACKS['pr']!, s, DEFAULT_CONFIG).filter((f) => f.check === 'pr.commits')).toEqual([]);
  });

  it('links issues by the forge relation, then closing keywords, then the branch name', async () => {
    expect(linkedOf([5], 'Closes #4', 'feat/3')).toEqual([5]);
    expect(linkedOf([], 'Closes #4, fixes #9', 'feat/3')).toEqual([4, 9]);
    expect(linkedOf([], 'no keyword', 'feat/3')).toEqual([3]);
    expect(linkedOf([], 'no keyword', 'scratch')).toEqual([]);
    expect(branchIssue('fix/12-short-title')).toBe(12);
    expect(branchIssue('12-title')).toBe(12);
    expect(branchIssue('release/v1.2')).toBeUndefined();
    expect(branchIssue('feat/12-title', '^feat/(?<issue>\\d+)-')).toBe(12);
    expect(branchIssue('user/44/feat', '^user/(?<issue>\\d+)/')).toBe(44);
    const forge = fakeForge({ closingIssues: async () => [8], pull: async (_r, n) => ({ ...(await fakeForge().pull('o/r', n)), body: 'Closes #4' }) });
    const s = await prSubject(forge, 'o/r', 7, DEFAULT_CONFIG);
    expect(s.facts['linked']).toEqual([8]);
    expect((s.state as { linked_issue: { number: number } }).linked_issue.number).toBe(8);
  });

  it('names the files two diffs both touch by their path after the change', () => {
    const a = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n';
    const b = 'diff --git a/new.ts b/new.ts\n@@ -1 +1 @@\n-p\n+q\ndiff --git a/other.ts b/other.ts\n@@ -1 +1 @@\n-1\n+2\n';
    expect(driftOf(a, b)).toEqual(['new.ts']);
    expect(driftOf(a, '')).toEqual([]);
    expect(driftOf('', b)).toEqual([]);
  });

  it('runs an isolated step against its context fields and lists only the items it ruled out', async () => {
    const pack: Pack = {
      name: 'isolated',
      subject: 'text',
      description: '',
      checks: [],
      questions: {},
      rank: [
        {
          from: 'parts',
          mode: 'isolated',
          list: 'violated',
          label: '{file} {name}',
          context: ['title', 'map'],
          questions: {
            off_topic: { type: 'noul', instructions: '{name} of {file} is off topic', inverted: true },
            patched: { type: 'noul', instructions: '{name} of {file} patches a symptom', inverted: true },
          },
        },
      ],
    };
    const parts = [
      { file: 'a.ts', name: 'f' },
      { file: 'a.ts', name: 'g' },
      { file: 'b.ts', name: 'h' },
    ];
    const s: Subject = { kind: 'text', ref: 't', state: { title: 'purpose', map: ['a.ts', 'b.ts'], ignored: 'never sent' }, facts: { parts }, options: {} };
    const states: Record<string, unknown>[] = [];
    const judge: Judge = {
      name: 'fake',
      ask: async (state, questions) => {
        states.push(state as Record<string, unknown>);
        const item = (state as { item: { name: string } }).item;
        const p = (id: string) => (id === 'patched' && item.name === 'g' ? 0.9 : id === 'off_topic' && item.name === 'h' ? 0.8 : 0.1);
        return { ok: true, answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', p: p(id) }])), backend: 'fake', latencyMs: 1 };
      },
    };
    const report = await runPack(pack, s, judge, DEFAULT_CONFIG);
    // one request per item, carrying the context fields and the item alone
    expect(states).toHaveLength(3);
    expect(Object.keys(states[0]!).sort()).toEqual(['item', 'map', 'title']);
    expect(states[1]!['item']).toEqual({ k: 1, file: 'a.ts', name: 'g' });
    const step = report.ranked[0]!;
    expect([step.list, step.total, step.kept]).toEqual(['violated', 3, 1]);
    expect(step.items.map((i) => i.label)).toEqual(['a.ts g', 'b.ts h']);
    expect(step.items[0]!.asked.map((j) => [j.id, j.band])).toEqual([['parts_2.off_topic', 'satisfied'], ['parts_2.patched', 'violated']]);
    expect(step.items[0]!).toMatchObject({ id: 'parts_2', band: 'satisfied', instructions: 'g of a.ts is off topic' });
    expect(report.verdict).toBe('warn');
    expect(formatReport(report).split('\n').slice(1)).toEqual(['  parts: 2 of 3 ruled out', '    [violated] a.ts g: patched = 0.90', '    [violated] b.ts h: off_topic = 0.80']);
    // an each list prints every question of every item
    const each: Pack = { ...pack, rank: [{ ...pack.rank![0]!, list: 'each' }] };
    const lines = formatReport(await runPack(each, s, judge, DEFAULT_CONFIG)).split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[4]).toBe('  [violated] parts_2.patched = 0.90: g of a.ts patches a symptom');
    // a step context names fields the state does not have without sending them
    expect(validatePack({ subject: 'text', rank: [{ from: 'parts', context: ['title'], questions: { q: { type: 'noul', instructions: 'x' } } }] }, 'ok').rank![0]!.context).toEqual(['title']);
    expect(() => validatePack({ subject: 'text', rank: [{ from: 'parts', context: 'title', questions: { q: { type: 'noul', instructions: 'x' } } }] }, 'bad')).toThrow(/context must be an array/);
  });

  it('reads the drift of a pull request from the base since the branch point as the files both changed', async () => {
    const calls: string[] = [];
    const forge = fakeForge({
      diff: async () => 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.ts b/y.ts\n@@ -1 +1 @@\n-a\n+b\n',
      compareDiff: async (_r, base, head) => {
        calls.push(`${base}...${head}`);
        return 'diff --git a/y.ts b/y.ts\n@@ -1 +1 @@\n-a\n+c\n';
      },
    });
    const s = await prSubject(forge, 'o/r', 7, DEFAULT_CONFIG);
    expect(calls).toEqual(['abc1234def...dev']);
    expect(s.facts['has_drift']).toBe(true);
    expect(s.facts['drift']).toEqual(['y.ts']);
    expect((s.state as { drift: string[] }).drift).toEqual(['y.ts']);
    // the patches never reach the state: no diff is judged
    for (const key of ['diff', 'changes']) expect(s.state[key]).toBeUndefined();
    expect(s.facts['hunks']).toBeUndefined();
    expect(runChecks(BUILTIN_PACKS['pr']!, s, DEFAULT_CONFIG).filter((f) => f.check === 'pr.drift')).toEqual([{ check: 'pr.drift', severity: 'warn', message: 'also changed on the base since the branch point: y.ts' }]);
    const clean = await prSubject(fakeForge({ diff: async () => 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b\n' }), 'o/r', 7, DEFAULT_CONFIG);
    expect(clean.facts['has_drift']).toBe(false);
    expect(runChecks(BUILTIN_PACKS['pr']!, clean, DEFAULT_CONFIG).filter((f) => f.check === 'pr.drift')).toEqual([]);
  });

  it('grades a pull request with its mechanical checks alone and never calls the judge', async () => {
    const pack = BUILTIN_PACKS['pr']!;
    expect(pack.checks).toEqual(['pr.linked', 'pr.target', 'pr.branch', 'pr.ci', 'pr.template', 'pr.commits', 'pr.drift']);
    expect(pack.questions).toEqual({});
    expect(pack.rank).toBeUndefined();
    const forge = fakeForge({
      pull: async (_r, n) => ({ ...(await fakeForge().pull('o/r', n)), body: 'no link', base: 'main', head: { branch: 'scratch', sha: 'h' } }),
      diff: async () => 'diff --git a/y.ts b/y.ts\n@@ -1 +1 @@\n-a\n+b\n',
      compareDiff: async () => 'diff --git a/y.ts b/y.ts\n@@ -1 +1 @@\n-a\n+c\n',
    });
    const config = resolveConfig({ branches: { pattern: '^feat/\\d+$' }, prs: { linkIssue: true, targets: ['dev'] } });
    const s = await prSubject(forge, 'o/r', 7, config);
    const report = await runPack(pack, s, unreachable, config);
    expect(report.mechanical.map((f) => f.check)).toEqual(['pr.linked', 'pr.target', 'pr.branch', 'pr.drift']);
    expect(report.judged).toEqual([]);
    expect(report.ranked).toEqual([]);
    expect(report.judgeError).toBeUndefined();
    expect(report.verdict).toBe('fail');
  });

  it('grades commits with the format check alone and never calls the judge', async () => {
    const pack = BUILTIN_PACKS['commit']!;
    expect(pack.checks).toEqual(['commit.format']);
    expect(pack.questions).toEqual({});
    expect(pack.rank).toBeUndefined();
    const calls: string[] = [];
    const git: Git = async (argv) => {
      calls.push(argv.join(' '));
      return `\u001e${'a'.repeat(40)}\nwat: y\n`;
    };
    const config = resolveConfig({ commits: { convention: 'conventional' } });
    const s = await commitSubject(git, 'abc1234', config);
    // the commit is read as its message, never as its diff
    expect(calls.every((c) => c.startsWith('log '))).toBe(true);
    expect(s.state['diff']).toBeUndefined();
    const report = await runPack(pack, s, unreachable, config);
    expect(report.mechanical.map((f) => f.message)).toEqual(['aaaaaaa uses unknown type wat']);
    expect(report.judged).toEqual([]);
    expect(report.judgeError).toBeUndefined();
    expect(report.verdict).toBe('fail');
  });

  it('ships no hunks pack', async () => {
    expect(BUILTIN_PACKS['hunks']).toBeUndefined();
    const packs = await loadPacks({ read: async () => '', exists: async () => false, list: async () => [] }, '/r');
    expect(Object.keys(packs)).not.toContain('hunks');
  });

  it('grades a local base..head range as the pr it would open, skipping the checks only a forge answers', async () => {
    const calls: string[] = [];
    const git: Git = async (argv) => {
      calls.push(argv.join(' '));
      if (argv[0] === 'diff' && argv[1] === 'dev...HEAD') return 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
      if (argv[0] === 'diff' && argv[1] === 'HEAD...dev') return 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+c\n';
      if (argv[0] === 'log') return `\u001e${'a'.repeat(40)}\nfeat(#12): twelve\n`;
      if (argv[0] === 'rev-parse') return 'feat/12\n';
      return '';
    };
    const config = resolveConfig({ branches: { pattern: '^(feat|fix)/(?<issue>\\d+)$' }, prs: { linkIssue: true, targets: ['dev'], templateSections: ['Summary'] } });
    const forge = fakeForge({ checks: async () => [{ name: 'ci', done: true, conclusion: 'failure', ok: false }] });
    const s = await prRangeSubject(git, 'dev..HEAD', config, { forge, repo: 'o/r' });
    expect(calls).toContain('log --format=%x1e%H%n%B --no-merges dev..HEAD');
    expect(s.ref).toBe('dev..HEAD');
    expect(s.facts['head']).toBe('feat/12');
    expect(s.facts['has_issue']).toBe(true);
    expect((s.state as { linked_issue: { number: number } }).linked_issue.number).toBe(12);
    expect((s.state as { commits: string[] }).commits).toEqual(['feat(#12): twelve']);
    expect(s.facts['has_drift']).toBe(true);
    expect(s.facts['drift']).toEqual(['x.ts']);
    for (const key of ['diff', 'changes']) expect(s.state[key]).toBeUndefined();
    for (const key of ['linked', 'base', 'checks_failed', 'sections']) expect(s.facts[key]).toBeUndefined();
    const findings = runChecks(BUILTIN_PACKS['pr']!, s, config);
    expect(findings.map((f) => f.check)).toEqual(['pr.drift']);
    const scratch = await prRangeSubject(async (argv) => (argv[0] === 'rev-parse' ? 'scratch\n' : ''), 'dev..HEAD', config, { forge, repo: 'o/r' });
    expect(scratch.facts['has_issue']).toBe(false);
    expect(runChecks(BUILTIN_PACKS['pr']!, scratch, config).map((f) => f.check)).toEqual(['pr.branch']);
    await expect(prRangeSubject(git, '..HEAD', config)).rejects.toThrow('no base');
  });

  it('reads a release from the forge when there is no checkout', async () => {
    const calls: string[] = [];
    const forge = fakeForge({
      tags: async () => ['v0.4.0', 'v0.3.0'],
      compare: async (_r, base, head) => {
        calls.push(`compare ${base}...${head}`);
        return [
          { sha: 'c'.repeat(40), message: 'feat(#3): three', merge: false },
          { sha: 'b'.repeat(40), message: 'Merge pull request #2', merge: true },
          { sha: 'a'.repeat(40), message: 'fix(#1): one', merge: false },
        ];
      },
      file: async (_r, path, ref) => {
        calls.push(`${path}@${ref}`);
        if (ref === 'v0.4.0') return '[dep.std]\nref = "tag/v5.0.0"\n';
        if (path.includes('CHANGELOG')) return undefined;
        return '[dep.std]\nref = "tag/v6.0.0"\n';
      },
    });
    const config = resolveConfig({ release: { scheme: 'semver', changelog: 'CHANGELOG.md', manifests: [{ path: 'mach.toml', keys: ['^dep\\.'], bump: 'minor' }] } });
    const s = await releaseSubject(remoteSource(forge, 'o/r', 'dev'), config);
    expect(s.ref).toBe('v0.4.0..dev');
    expect((s.facts['commits'] as { subject: string }[]).map((c) => c.subject)).toEqual(['feat(#3): three', 'fix(#1): one']);
    expect(s.facts['bump']).toBe('minor');
    expect(s.facts['manifests']).toHaveLength(1);
    expect(s.facts['changelogPath']).toBeUndefined();
    expect(s.facts['changelog_changed']).toBe(false);
    expect(calls).toContain('compare v0.4.0...dev');
    expect(calls).toContain('mach.toml@dev');
  });

  it('reads a release from the checkout, taking the working tree for HEAD', async () => {
    const git: Git = async (argv) => {
      if (argv[0] === 'tag') return 'v1.0.0\n';
      if (argv[0] === 'log') return `\u001e${'d'.repeat(40)}\nfeat(#4): four\n`;
      if (argv[0] === 'show') return argv[1] === 'v1.0.0:CHANGELOG.md' ? '# Changelog\n\n## 1.0.0\n- old' : '';
      return '';
    };
    const config = resolveConfig({ release: { scheme: 'semver', changelog: 'CHANGELOG.md' } });
    const s = await releaseSubject(localSource(git, 'HEAD', async () => '# Changelog\n\n## Unreleased\n- four\n\n## 1.0.0\n- old', async () => true), config);
    expect(s.ref).toBe('v1.0.0..HEAD');
    expect(s.facts['changelogAdded']).toBe('## Unreleased\n- four\n');
    expect(s.facts['changelog_changed']).toBe(true);
    expect((s.state as { changelog_diff: string }).changelog_diff).toBe('+## Unreleased\n+- four\n+');
    expect(s.facts['bump']).toBe('minor');
  });

  it('reads markdown structure', () => {
    expect(Object.keys(sectionsOf('## Summary\nx\n## Steps\n- a'))).toEqual(['Summary', 'Steps']);
    expect(linkedIssues('Closes #4, fixes #9 and #10')).toEqual([4, 9]);
  });
});
