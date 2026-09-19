import { describe, expect, it } from 'vitest';
import type { Gh } from '../src/github/gh.ts';
import { bumpVersion, parseCommit, parseLog, requiredBump } from '../src/github/commits.ts';
import { flattenToml, manifestChanges } from '../src/github/manifest.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/github/config.ts';
import { splitResponse } from '../src/github/gh.ts';
import { lastReleaseTag, linkedIssues, prSubject, releaseSubject, ruleDoc, ruleParagraphs, sectionsOf, topSection } from '../src/github/subjects.ts';
import { localSource, remoteSource } from '../src/github/source.ts';
import type { Answers, Judge } from '../src/judge/types.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { validatePack } from '../src/packs/load.ts';
import { materialize, runChecks, runPack, verdictOf } from '../src/packs/run.ts';
import type { Subject } from '../src/packs/types.ts';

const answering = (answers: Answers): Judge => ({
  name: 'fake',
  ask: async () => ({ ok: true, answers, backend: 'fake', latencyMs: 1 }),
});

describe('conventional commits', () => {
  it('parses type, scope, breaking marker and trailers', () => {
    const c = parseCommit('abc', 'feat(#12)!: add thing\n\nbody\n\nCo-Authored-By: x');
    expect(c).toMatchObject({ type: 'feat', scope: '#12', breaking: true, conventional: true, trailers: ['Co-Authored-By'] });
    expect(parseCommit('d', 'random message').conventional).toBe(false);
    expect(parseCommit('e', 'fix: x\n\nBREAKING CHANGE: y').breaking).toBe(true);
  });

  it('computes the required bump', () => {
    const log = parseLog('\u001eaaa\nfix: a\n\u001ebbb\nfeat: b\n\u001eccc\nchore: c\n');
    expect(requiredBump(log)).toBe('minor');
    expect(requiredBump([parseCommit('x', 'refactor!: y')])).toBe('major');
    expect(requiredBump([parseCommit('x', 'docs: y')])).toBe('none');
    expect(requiredBump([parseCommit('x', 'feat(#222)!: y')], [0, 17, 2])).toBe('minor');
    expect(requiredBump([parseCommit('x', 'feat(#222)!: y')], [0, 17, 2], 'major')).toBe('major');
    expect(requiredBump([parseCommit('x', 'feat(#222)!: y')], [1, 0, 0])).toBe('major');
    expect(bumpVersion([0, 3, 1], 'minor')).toEqual([0, 4, 0]);
    expect(bumpVersion([1, 3, 1], 'major')).toEqual([2, 0, 0]);
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
      '1234567 scope must be #<issue>, got (auth)',
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
    const release: Subject = { kind: 'release', ref: 'HEAD', state: {}, facts: { has_commits: true, bump: 'minor', version: [1, 2, 3], proposed: 'v1.2.4' }, options: {} };
    expect(runChecks(BUILTIN_PACKS['release']!, release, resolveConfig(undefined))).toEqual([]);
    const semver = runChecks(BUILTIN_PACKS['release']!, release, resolveConfig({ release: { scheme: 'semver' } }));
    expect(semver.map((f) => f.message)).toEqual(['required bump: minor, next version v1.3.0, from commits minor', 'v1.2.4 is a patch bump, the changes require minor']);
  });

  it('reads dependency floors out of a manifest and names the changed keys', () => {
    const before = '[project]\nid = "hedge"\nversion = "0.7.0"\nmach = "^5.3"\n\n[dep.std]\ngit = "https://x/std"\nref = "tag/v5.7.0"\n';
    const after = '[project]\nid = "hedge"\nversion = "0.7.1"\nmach = "^5.9" # floor\n\n[dep.std]\ngit = "https://x/std"\nref = "tag/v6.0.0"\n\n[dep.tls]\ngit = "https://x/tls"\nref = "tag/v0.8.1"\n';
    expect(flattenToml(after)['project.mach']).toBe('"^5.9"');
    const rule = { path: 'mach.toml', keys: ['^project\\.mach$', '^dep\\.[^.]+\\.(git|ref)$'], bump: 'minor' as const };
    const changes = manifestChanges(rule, before, after);
    expect(changes.map((c) => `${c.key} ${c.from} -> ${c.to}`)).toEqual(['project.mach "^5.3" -> "^5.9"', 'dep.std.ref "tag/v5.7.0" -> "tag/v6.0.0"', 'dep.tls.git null -> "https://x/tls"', 'dep.tls.ref null -> "tag/v0.8.1"']);
    expect(manifestChanges(rule, before, before)).toEqual([]);
    const release: Subject = {
      kind: 'release',
      ref: 'HEAD',
      state: {},
      facts: { has_commits: true, bump: 'minor', commitBump: 'none', manifestBump: 'minor', manifests: changes.slice(0, 1), version: [0, 7, 0] },
      options: {},
    };
    const findings = runChecks(BUILTIN_PACKS['release']!, release, resolveConfig({ release: { scheme: 'semver' } }));
    expect(findings.map((f) => f.message)).toEqual(['required bump: minor, next version v0.8.0, from mach.toml project.mach "^5.3" -> "^5.9" (minor)']);
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
    expect(report.judged).toHaveLength(900);
    expect(report.mechanical).toEqual([]);
    const capped = runChecks(BUILTIN_PACKS['rules']!, { ...subject, facts: { ...subject.facts, total_rules: 900 } }, resolveConfig(undefined));
    expect(capped[0]!.message).toBe('200 of 900 rules used, raise rules.maxRules to judge the rest');
  });

  it('layers config sources in order', () => {
    const config = resolveConfig([{ commits: { convention: 'conventional', scope: 'issue' }, prs: { target: 'dev' } }, { commits: { scope: 'any' } }], 'main');
    expect(config.commits).toMatchObject({ convention: 'conventional', scope: 'any' });
    expect(config.prs.target).toBe('dev');
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

describe('pack materialization', () => {
  it('skips when-gated questions, fills runtime options, and expands rules', () => {
    const subject: Subject = { kind: 'issue', ref: 'x', state: {}, facts: { has_others: true }, options: { open_issues: { '#3': 'three' }, type_labels: {} } };
    const { questions } = materialize(BUILTIN_PACKS['issue']!, subject);
    expect(questions['duplicate_of']).toMatchObject({ type: 'choice', criteria: { '#3': 'three', none: expect.any(String) } });
    expect(questions['type']).toBeUndefined();
    const rules: Subject = { kind: 'rules', ref: 'x', state: {}, facts: { rules: [{ text: 'no em dashes' }, { text: 'tests pass' }] }, options: {} };
    const expanded = materialize(BUILTIN_PACKS['rules']!, rules);
    expect(Object.keys(expanded.questions)).toEqual(['rules_1', 'rules_2']);
    expect(expanded.questions['rules_1']!.instructions).toContain('no em dashes');
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
    expect(lastReleaseTag(['v0.3.4', 'v0.10.0', 'v0.9.1', 'nightly'], 'v')).toBe('v0.10.0');
    expect(lastReleaseTag([], 'v')).toBeUndefined();
  });

  it('drops merge commits from a pull request before the convention judges them', async () => {
    const gh = {
      json: async (path: string) => {
        if (path === 'repos/o/r/pulls/7') return { title: 't', body: 'Closes #1', user: { login: 'me' }, base: { ref: 'dev' }, head: { ref: 'perf/1', sha: 'h' }, draft: false, additions: 1, deletions: 0, changed_files: 1 };
        if (path.startsWith('repos/o/r/pulls/7/commits')) {
          return [
            { sha: 'a'.repeat(40), parents: [{ sha: 'x' }], commit: { message: 'perf(#1): faster' } },
            { sha: 'b'.repeat(40), parents: [{ sha: 'a'.repeat(40) }, { sha: 'y' }], commit: { message: "Merge remote-tracking branch 'origin/dev' into perf/1" } },
          ];
        }
        if (path.startsWith('repos/o/r/issues/1')) return { number: 1, title: 'one', body: '' };
        if (path.includes('/comments')) return [];
        if (path.includes('/check-runs')) return { check_runs: [] };
        throw new Error(path);
      },
      text: async () => 'diff',
    } as unknown as Gh;
    const s = await prSubject(gh, 'o/r', 7, DEFAULT_CONFIG);
    expect((s.facts['commits'] as { message: string }[]).map((c) => c.message)).toEqual(['perf(#1): faster']);
    expect((s.state as { commits: string[] }).commits).toEqual(['perf(#1): faster']);
    expect(runChecks(BUILTIN_PACKS['pr']!, s, DEFAULT_CONFIG).filter((f) => f.check === 'pr.commits')).toEqual([]);
  });

  it('reads a release from github when there is no checkout', async () => {
    const calls: string[] = [];
    const gh = {
      pages: async (path: string) => {
        calls.push(path);
        return path.startsWith('repos/o/r/tags') ? ['v0.4.0', 'v0.3.0'] : [];
      },
      json: async (path: string) => {
        calls.push(path);
        return {
          commits: [
            { sha: 'a'.repeat(40), parents: [{ sha: 'x' }], commit: { message: 'fix(#1): one' } },
            { sha: 'b'.repeat(40), parents: [{ sha: 'x' }, { sha: 'y' }], commit: { message: 'Merge pull request #2' } },
            { sha: 'c'.repeat(40), parents: [{ sha: 'x' }], commit: { message: 'feat(#3): three' } },
          ],
        };
      },
      text: async (path: string) => {
        calls.push(path);
        if (path.includes('ref=v0.4.0')) return '[dep.std]\nref = "tag/v5.0.0"\n';
        if (path.includes('CHANGELOG')) throw new Error('404');
        return '[dep.std]\nref = "tag/v6.0.0"\n';
      },
    } as unknown as Gh;
    const config = resolveConfig({ release: { scheme: 'semver', changelog: 'CHANGELOG.md', manifests: [{ path: 'mach.toml', keys: ['^dep\\.'], bump: 'minor' }] } });
    const s = await releaseSubject(remoteSource(gh, 'o/r', 'dev'), config);
    expect(s.ref).toBe('v0.4.0..dev');
    expect((s.facts['commits'] as { subject: string }[]).map((c) => c.subject)).toEqual(['feat(#3): three', 'fix(#1): one']);
    expect(s.facts['bump']).toBe('minor');
    expect(s.facts['manifests']).toHaveLength(1);
    expect(s.facts['changelogPath']).toBeUndefined();
    expect(calls).toContain('repos/o/r/compare/v0.4.0...dev');
    expect(calls).toContain('repos/o/r/contents/mach.toml?ref=dev');
  });

  it('reads a release from the checkout, taking the working tree for HEAD', async () => {
    const gh = {
      git: async (argv: string[]) => {
        if (argv[0] === 'tag') return 'v1.0.0\n';
        if (argv[0] === 'log') return `\u001e${'d'.repeat(40)}\nfeat(#4): four\n`;
        if (argv[0] === 'show') return argv[1] === 'v1.0.0:CHANGELOG.md' ? '## 1.0.0\n- old' : '';
        return '';
      },
    } as unknown as Gh;
    const config = resolveConfig({ release: { scheme: 'semver', changelog: 'CHANGELOG.md' } });
    const s = await releaseSubject(localSource(gh, 'HEAD', async () => '## Unreleased\n- four\n\n## 1.0.0\n- old', async () => true), config);
    expect(s.ref).toBe('v1.0.0..HEAD');
    expect(s.facts['unreleased']).toBe('## Unreleased\n- four');
    expect(s.facts['bump']).toBe('minor');
  });

  it('reads markdown structure', () => {
    expect(Object.keys(sectionsOf('## Summary\nx\n## Steps\n- a'))).toEqual(['Summary', 'Steps']);
    expect(linkedIssues('Closes #4, fixes #9 and #10')).toEqual([4, 9]);
    expect(topSection('# Changelog\n\n## Unreleased\n- a\n\n## 1.0.0\n- b')).toBe('## Unreleased\n- a');
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

  it('reads a rule doc from the checkout or from github by owner/repo:path@ref', async () => {
    const calls: string[] = [];
    const gh = { text: async (path: string) => (calls.push(path), '# remote') } as unknown as Gh;
    expect(await ruleDoc('CONTRIBUTING.md', gh, async () => '# local', async (p: string) => p === 'CONTRIBUTING.md')).toBe('# local');
    expect(await ruleDoc('MISSING.md', gh, async () => '', async () => false)).toBeUndefined();
    expect(await ruleDoc('briar-systems/mach-std:MIGRATION.md@v6.0.0', gh, async () => '', async () => false)).toBe('# remote');
    expect(calls).toEqual(['repos/briar-systems/mach-std/contents/MIGRATION.md?ref=v6.0.0']);
    expect(await ruleDoc('o/r:doc/RULES.md', gh, async () => '', async () => false)).toBe('# remote');
    expect(calls[1]).toBe('repos/o/r/contents/doc/RULES.md');
    expect(await ruleDoc('o/r:doc/RULES.md', undefined, async () => '', async () => false)).toBeUndefined();
  });
});
