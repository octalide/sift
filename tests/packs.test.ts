import { describe, expect, it } from 'vitest';
import type { Git } from '../src/forge/git.ts';
import { parseCommit, parseLog, requiredBump } from '../src/github/commits.ts';
import { bumpBetween, bumpVersion, compareVersions, parseTag, parseVersion, SEMVER_PATTERN, CALVER_PATTERN } from '../src/github/version.ts';
import { flattenManifest, manifestChanges, parseToml, parseYaml } from '../src/github/manifest.ts';
import { lineDiff } from '../src/github/diff.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/github/config.ts';
import { splitResponse } from '../src/github/gh.ts';
import { branchIssue, lastReleaseTag, linkedIssues, linkedOf, planSubject, prSubject, releaseSubject, ruleDoc, ruleParagraphs, sectionsOf } from '../src/github/subjects.ts';
import { localSource, remoteSource } from '../src/github/source.ts';
import type { Answers, Judge } from '../src/judge/types.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { validatePack } from '../src/packs/load.ts';
import { materialize, runChecks, runPack, verdictOf } from '../src/packs/run.ts';
import { fakeForge } from './fake-forge.ts';
import type { Subject } from '../src/packs/types.ts';

const answering = (answers: Answers): Judge => ({
  name: 'fake',
  ask: async () => ({ ok: true, answers, backend: 'fake', latencyMs: 1 }),
});

describe('conventional commits', () => {
  it('parses type, scope, breaking marker and trailers', () => {
    const c = parseCommit('abc', 'feat(#12)!: add thing\n\nbody\n\nCo-Authored-By: x');
    expect(c).toMatchObject({ type: 'feat', scope: '#12', description: 'add thing', breaking: true, matched: true, trailers: ['Co-Authored-By'] });
    expect(parseCommit('d', 'random message').matched).toBe(false);
    expect(parseCommit('e', 'fix: x\n\nBREAKING CHANGE: y').breaking).toBe(true);
  });

  it('computes the required bump', () => {
    const log = parseLog('\u001eaaa\nfix: a\n\u001ebbb\nfeat: b\n\u001eccc\nchore: c\n');
    expect(requiredBump(log)).toBe('minor');
    expect(requiredBump([parseCommit('x', 'refactor!: y')])).toBe('major');
    expect(requiredBump([parseCommit('x', 'docs: y')])).toBe('none');
    const v = (raw: string) => parseVersion(raw, SEMVER_PATTERN)!;
    expect(requiredBump([parseCommit('x', 'feat(#222)!: y')], v('0.17.2'))).toBe('minor');
    expect(requiredBump([parseCommit('x', 'feat(#222)!: y')], v('0.17.2'), 'major')).toBe('major');
    expect(requiredBump([parseCommit('x', 'feat(#222)!: y')], v('1.0.0'))).toBe('major');
    expect(bumpVersion(v('0.3.1'), 'minor', SEMVER_PATTERN)).toBe('0.4.0');
    expect(bumpVersion(v('1.3.1'), 'major', SEMVER_PATTERN)).toBe('2.0.0');
    expect(bumpVersion(v('1.9.9-rc.1'), 'patch', SEMVER_PATTERN)).toBe('1.9.10');
    expect(bumpBetween(v('1.2.3'), v('1.3.0'))).toBe('minor');
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
    const subject: Subject = { kind: 'rules', ref: 't', state: { rules }, facts: { rules, has_rules: true, total_rules: 900 }, options: {} };
    const report = await runPack(BUILTIN_PACKS['rules']!, subject, judge, resolveConfig({ rules: { maxRules: 900 } }));
    expect(asks.length).toBeGreaterThan(1);
    expect(asks.reduce((a, b) => a + b, 0)).toBe(900);
    expect(report.judged).toEqual([]);
    expect(report.ranked[0]!.items).toHaveLength(900);
    expect(report.mechanical).toEqual([]);
    const capped = runChecks(BUILTIN_PACKS['rules']!, { ...subject, facts: { ...subject.facts, total_rules: 900 } }, resolveConfig(undefined));
    expect(capped[0]!.message).toBe('200 of 900 rules used, raise rules.maxRules to judge the rest');
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
    const subject: Subject = { kind: 'pr', ref: 'p', state: {}, facts: { has_issue: true, has_diff: true }, options: {} };
    const report = await runPack(
      BUILTIN_PACKS['pr']!,
      subject,
      answering({
        addresses_issue: { type: 'noul', p: 0.95 },
        scope_creep: { type: 'noul', p: 0.9 },
        workaround: { type: 'noul', p: 0.1 },
        contract_change: { type: 'noul', p: 0.5 },
        tests_cover: { type: 'noul', p: 0.8 },
        risk: { type: 'score', score: 0, expected: 0, legend: 'low', probabilities: [1, 0, 0], confidence: 1 },
      }),
      DEFAULT_CONFIG,
    );
    const bands = Object.fromEntries(report.judged.map((j) => [j.id, j.band]));
    expect(bands).toMatchObject({ addresses_issue: 'satisfied', scope_creep: 'violated', workaround: 'satisfied', contract_change: 'unclear' });
    expect(report.verdict).toBe('warn');
  });

  it('reports unknown when the judge is unavailable and validates pack files', async () => {
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'off' }) };
    const report = await runPack(BUILTIN_PACKS['pr']!, { kind: 'pr', ref: 'p', state: {}, facts: { has_diff: true }, options: {} }, off, DEFAULT_CONFIG);
    expect(report.verdict).toBe('unknown');
    expect(() => validatePack({ subject: 'issue', questions: { q: { type: 'nope', instructions: 'x' } } }, 'bad')).toThrow(/unknown type/);
    expect(validatePack({ subject: 'text', questions: { q: { type: 'noul', instructions: 'x' } } }, 'ok').name).toBe('ok');
    expect(() => validatePack({ subject: 'text', questions: { q: { type: 'noul', instructions: 'x', criteria: 'prose' } } }, 'bad')).toThrow(/true, false/);
    expect(validatePack({ subject: 'text', questions: { q: { type: 'noul', instructions: 'x', criteria: { true: 'yes', false: 'no' } } } }, 'ok').name).toBe('ok');
  });
  it('reads a plan beside its issue and fails on an unasked decision', async () => {
    const forge = fakeForge({ issue: async (_r, n) => ({ ...(await fakeForge().issue('o/r', n)), title: 'plan pack', body: 'New pack `plan`.' }) });
    const s = await planSubject(forge, 'o/r', 61, 'add the pack');
    expect(s.kind).toBe('plan');
    expect(s.ref).toBe('o/r#61');
    expect(s.state).toMatchObject({ number: 61, issue: { title: 'plan pack', body: 'New pack `plan`.' }, plan: 'add the pack' });
    expect(s.facts['has_plan']).toBe(true);
    expect(BUILTIN_PACKS['plan']!.checks).toEqual([]);
    const report = await runPack(
      BUILTIN_PACKS['plan']!,
      s,
      answering({ covers: { type: 'noul', p: 0.9 }, adds_nothing: { type: 'noul', p: 0.1 }, decides_unasked: { type: 'noul', p: 0.9 } }),
      DEFAULT_CONFIG,
    );
    const bands = Object.fromEntries(report.judged.map((j) => [j.id, j.band]));
    expect(bands).toEqual({ covers: 'satisfied', adds_nothing: 'satisfied', decides_unasked: 'violated' });
    expect(report.verdict).toBe('fail');
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
    const forge = fakeForge({ closingIssues: async () => [8], pull: async (_r, n) => ({ ...(await fakeForge().pull('o/r', n)), body: 'Closes #4' }) });
    const s = await prSubject(forge, 'o/r', 7, DEFAULT_CONFIG);
    expect(s.facts['linked']).toEqual([8]);
    expect((s.state as { linked_issue: { number: number } }).linked_issue.number).toBe(8);
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
    const rules = ruleParagraphs('# Style\n\nNo em dashes, no semicolons.\n\n- Conventional commits.\n- Tiny.\n\n```\ncode ignored\n```');
    expect(rules).toEqual(['Style: No em dashes, no semicolons.', 'Style: Conventional commits.']);
  });

  it('turns each markdown table row into one rule named by the header', () => {
    const doc = '## Sorting (#655)\n\n`sort` no longer takes a comparator.\n\n| 5.x | 6.0.0 |\n| --- | --- |\n| `sort.sort[T](data, len, cmp)` | `sort.sort[T](data, len)` |\n| `sort.is_sorted[T](d, n, cmp)` | `sort.is_sorted_by[T](d, n, cmp)` |\nA line after the table.\n';
    expect(ruleParagraphs(doc)).toEqual([
      'Sorting (#655): `sort` no longer takes a comparator.',
      'Sorting (#655): 5.x: `sort.sort[T](data, len, cmp)`; 6.0.0: `sort.sort[T](data, len)`',
      'Sorting (#655): 5.x: `sort.is_sorted[T](d, n, cmp)`; 6.0.0: `sort.is_sorted_by[T](d, n, cmp)`',
      'Sorting (#655): A line after the table.',
    ]);
  });

  it('reads a rule doc from the checkout or from the forge by repo:path@ref', async () => {
    const calls: string[] = [];
    const forge = fakeForge({ file: async (repo, path, ref) => (calls.push(`${repo}:${path}@${ref}`), '# remote') });
    expect(await ruleDoc('CONTRIBUTING.md', forge, async () => '# local', async (p: string) => p === 'CONTRIBUTING.md')).toBe('# local');
    expect(await ruleDoc('MISSING.md', forge, async () => '', async () => false)).toBeUndefined();
    expect(await ruleDoc('briar-systems/mach-std:MIGRATION.md@v6.0.0', forge, async () => '', async () => false)).toBe('# remote');
    expect(calls).toEqual(['briar-systems/mach-std:MIGRATION.md@v6.0.0']);
    expect(await ruleDoc('o/r:doc/RULES.md', forge, async () => '', async () => false)).toBe('# remote');
    expect(calls[1]).toBe('o/r:doc/RULES.md@undefined');
    expect(await ruleDoc('group/sub/project:RULES.md', forge, async () => '', async () => false)).toBe('# remote');
    expect(calls[2]).toBe('group/sub/project:RULES.md@undefined');
    expect(await ruleDoc('o/r:doc/RULES.md', undefined, async () => '', async () => false)).toBeUndefined();
  });
});
