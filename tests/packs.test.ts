import { describe, expect, it } from 'vitest';
import { bumpVersion, parseCommit, parseLog, requiredBump } from '../src/github/commits.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/github/config.ts';
import { splitResponse } from '../src/github/gh.ts';
import { linkedIssues, ruleParagraphs, sectionsOf, topSection } from '../src/github/subjects.ts';
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
    expect(bumpVersion([0, 3, 1], 'major')).toEqual([0, 4, 0]);
    expect(bumpVersion([1, 3, 1], 'major')).toEqual([2, 0, 0]);
  });
});

describe('mechanical checks', () => {
  it('flags forbidden trailers, unknown types and bad scopes', () => {
    const config = resolveConfig({ commits: { scope: 'issue', forbidTrailers: ['Co-Authored-By'] } });
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

  it('requires label groups and milestones only when configured', async () => {
    const config = resolveConfig({ issues: { requiredLabelGroups: [['bug', 'feat']], milestone: true, templateSections: ['Summary'] } });
    const subject: Subject = {
      kind: 'issue',
      ref: 'r#1',
      state: {},
      facts: { labels: ['docs'], sections: { Summary: '<!-- fill me -->' }, has_others: false },
      options: {},
    };
    const report = await runPack(BUILTIN_PACKS['issue']!, subject, answering({ substantive: { type: 'noul', p: 0.9 }, single_repo: { type: 'noul', p: 0.9 }, needs_parent: { type: 'noul', p: 0.1 }, readiness: { type: 'score', score: 2, legend: 'ready', probabilities: [0, 0, 1], confidence: 1 } }), config);
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
        risk: { type: 'score', score: 0, legend: 'low', probabilities: [1, 0, 0], confidence: 1 },
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

  it('reads markdown structure', () => {
    expect(Object.keys(sectionsOf('## Summary\nx\n## Steps\n- a'))).toEqual(['Summary', 'Steps']);
    expect(linkedIssues('Closes #4, fixes #9 and #10')).toEqual([4, 9]);
    expect(topSection('# Changelog\n\n## Unreleased\n- a\n\n## 1.0.0\n- b')).toBe('## Unreleased\n- a');
    const rules = ruleParagraphs('# Style\n\nNo em dashes, no semicolons.\n\n- Conventional commits.\n- Tiny.\n\n```\ncode ignored\n```');
    expect(rules).toEqual(['Style: No em dashes, no semicolons.', 'Style: Conventional commits.']);
  });
});
