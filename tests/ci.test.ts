import { describe, expect, it } from 'vitest';
import { ciSubject, cleanLine, logSubject, textLog, trimLog } from '../src/ci/log.ts';
import type { Job, JobLog } from '../src/forge/forge.ts';
import { DEFAULT_CONFIG } from '../src/repo/config.ts';
import { diffFiles } from '../src/repo/diff.ts';
import type { Judge } from '../src/judge/types.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { formatReport, runPack } from '../src/packs/run.ts';
import { fakeForge } from './fake-forge.ts';
import { MACH_CI, MACH_JOBS, MACH_RUN } from './fixtures/mach-ci.ts';
import { fillNeeds, workflowJobs } from '../src/forge/workflow.ts';

const log: JobLog = {
  job: 'test',
  run: '3',
  sha: 'abc1234def',
  url: 'https://x/job/7',
  steps: [
    { name: 'Set up job', ok: true, text: '2026-09-21T02:35:09.9377426Z Current runner version: 2.337.0' },
    { name: 'Run actions/checkout@v6', ok: true, text: '2026-09-21T02:35:10.6877018Z ##[group]Run actions/checkout@v6\n2026-09-21T02:35:10.6889601Z ##[endgroup]' },
    {
      name: 'Run npm test',
      ok: false,
      text: [
        '2026-09-21T02:35:32.9188808Z ##[group]Run npm test',
        '2026-09-21T02:35:32.9189137Z \u001b[36;1mnpm test\u001b[0m',
        '2026-09-21T02:35:32.9239413Z ##[endgroup]',
        '2026-09-21T02:35:33.0000000Z > vitest run',
        '2026-09-21T02:35:33.0000000Z ',
        '2026-09-21T02:35:34.0000000Z \u001b[32m✓\u001b[0m tests/a.test.ts (3 tests)',
        '2026-09-21T02:35:35.0000000Z \u001b[31mFAIL\u001b[0m tests/packs.test.ts > runs steps before questions',
        '2026-09-21T02:35:35.0000000Z AssertionError: expected 2 to be 1',
        '2026-09-21T02:35:36.0000000Z ##[error]Process completed with exit code 1.',
      ].join('\n'),
    },
    { name: 'Post job cleanup', ok: true, text: '2026-09-21T02:47:54.6774571Z Post job cleanup.' },
  ],
};

// a judge that keys on the words of a failing test line, in batched rank keys, and answers the fixed questions by name
const reader: Judge = {
  name: 'fake',
  ask: async (state, questions) => {
    const s = state as { items?: { k: number; text: string }[]; lines?: { text: string }[]; pull_request?: { files: { path: string }[] } | null };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => {
        if (s.items) {
          const k = Number(key.slice(key.lastIndexOf('_') + 1));
          const text = s.items.find((i) => i.k === k)!.text;
          return [key, { type: 'noul' as const, p: /FAIL|AssertionError|exit code/.test(text) ? 0.9 : 0.1 }];
        }
        const lines = (s.lines ?? []).map((l) => l.text).join('\n');
        const files = (s.pull_request?.files ?? []).map((f) => f.path);
        if (key === 'own_fault') return [key, { type: 'noul' as const, p: files.some((f) => lines.includes(f)) ? 0.9 : 0.2 }];
        if (key === 'environment') return [key, { type: 'noul' as const, p: 0.1 }];
        return [key, { type: 'noul' as const, p: 0.8 }];
      }),
    );
    return { ok: true, backend: 'fake', latencyMs: 1, answers };
  },
};

describe('log trimming', () => {
  it('strips timestamps, colours and marks, keeps error marks', () => {
    expect(cleanLine('﻿2026-09-21T02:35:09.9377426Z Current runner version')).toBe('Current runner version');
    expect(cleanLine('2026-09-21T02:35:32.9189137Z \u001b[36;1mnpm test\u001b[0m')).toBe('npm test');
    expect(cleanLine('2026-09-21T02:35:32.9239413Z ##[endgroup]')).toBeUndefined();
    expect(cleanLine('2026-09-21T02:35:33.0000000Z ')).toBeUndefined();
    expect(cleanLine('2026-09-21T02:35:36.0000000Z ##[error]Process completed with exit code 1.')).toBe('##[error]Process completed with exit code 1.');
    expect(cleanLine('no timestamp at all')).toBe('no timestamp at all');
  });

  it('trims to the failing step, else the tail of the whole log, on a bound', () => {
    const trimmed = trimLog(log);
    expect(trimmed.step).toBe('Run npm test');
    expect(trimmed.lines.map((l) => l.text)).toEqual(['npm test', '> vitest run', '✓ tests/a.test.ts (3 tests)', 'FAIL tests/packs.test.ts > runs steps before questions', 'AssertionError: expected 2 to be 1', '##[error]Process completed with exit code 1.']);
    expect(trimmed.lines[0]).toEqual({ n: 1, text: 'npm test' });
    const bounded = trimLog(log, { tailLines: 2 });
    expect(bounded.lines.map((l) => l.n)).toEqual([1, 2]);
    expect(bounded.lines[1]!.text).toBe('##[error]Process completed with exit code 1.');
    expect(bounded.total).toBe(6);
    const whole = trimLog({ ...log, steps: log.steps.map((s) => ({ ...s, ok: true })) }, { tailLines: 3 });
    expect(whole.step).toBeUndefined();
    expect(whole.lines.map((l) => l.text)).toEqual(['AssertionError: expected 2 to be 1', '##[error]Process completed with exit code 1.', 'Post job cleanup.']);
    expect(trimLog(textLog('a\nb'), { lineWidth: 1 }).lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('lists the files a diff touches', () => {
    const diff = 'diff --git a/src/packs/run.ts b/src/packs/run.ts\n--- a/src/packs/run.ts\n+++ b/src/packs/run.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\ndiff --git a/README.md b/README.md\n+++ b/README.md\n+x\n';
    expect(diffFiles(diff)).toEqual([
      { path: 'src/packs/run.ts', additions: 2, deletions: 1 },
      { path: 'README.md', additions: 1, deletions: 0 },
    ]);
    expect(diffFiles('')).toEqual([]);
  });
});

describe('ci pack', () => {
  it('ranks the lines, feeds the kept ones to the questions beside the pull request files, and prints lines then answers', async () => {
    const subject = logSubject(log, { number: 3, title: 'Feat 3', branch: 'feat/3', files: [{ path: 'tests/packs.test.ts', additions: 4, deletions: 0 }] }, 'o/r job 7');
    const report = await runPack(BUILTIN_PACKS['ci']!, subject, reader, DEFAULT_CONFIG, { top: 3 });
    expect(report.mechanical).toEqual([{ check: 'log.trimmed', severity: 'info', message: '6 of 6 lines read from the failing step Run npm test' }]);
    expect(report.ranked.map((r) => [r.step, r.total, r.kept, r.items.map((i) => i.label)])).toEqual([
      ['lines', 6, 3, ['4: FAIL tests/packs.test.ts > runs steps before questions', '5: AssertionError: expected 2 to be 1', '6: ##[error]Process completed with exit code 1.']],
    ]);
    expect(Object.fromEntries(report.judged.map((j) => [j.id, j.band]))).toEqual({ own_fault: 'satisfied', environment: 'violated', fixable_here: 'satisfied' });
    expect(report.verdict).toBe('pass');
    const text = formatReport(report).split('\n');
    expect(text[2]).toBe('  lines: top 3 of 6, 3 not ruled out');
    expect(text[3]).toBe('    1. [satisfied] 4: FAIL tests/packs.test.ts > runs steps before questions = 0.90');
    expect(text[6]).toMatch(/^  \[satisfied\] own_fault = 0\.90/);
    expect(text[7]).toMatch(/^  \[violated\] environment = 0\.10/);
    expect(text[8]).toMatch(/^  \[satisfied\] fixable_here = 0\.80/);
  });

  it('asks about the change under test only when a pull request is known', async () => {
    const subject = logSubject(textLog('FAIL x\n'), undefined, 'text');
    const report = await runPack(BUILTIN_PACKS['ci']!, subject, reader, DEFAULT_CONFIG);
    expect(report.judged.map((j) => j.id)).toEqual(['environment', 'fixable_here']);
    expect(report.mechanical[0]!.message).toBe('1 of 1 lines read from the failing step log');
    const empty = await runPack(BUILTIN_PACKS['ci']!, logSubject(textLog(''), undefined, 'text'), reader, DEFAULT_CONFIG);
    expect(empty.mechanical[0]).toMatchObject({ severity: 'warn', message: 'the log is empty' });
  });

  it('reads a job through the forge with the open pull request on its head, and a run through its first failed job', async () => {
    const calls: string[] = [];
    const forge = fakeForge({
      jobs: async (_r, run) => {
        calls.push(`jobs ${run}`);
        return [
          { id: '6', name: 'lint', run: '3', sha: 'abc1234def', done: true, conclusion: 'success', ok: true, url: 'u6' },
          { id: '7', name: 'test', run: '3', sha: 'abc1234def', done: true, conclusion: 'failure', ok: false, url: 'u7' },
        ];
      },
      jobLog: async (_r, id) => {
        calls.push(`log ${id}`);
        return log;
      },
      pulls: async () => ({ changed: true, rate: {}, value: [{ number: 3, title: 'Feat 3', branch: 'feat/3', sha: 'abc1234def', url: 'https://x/pull/3', user: 'alice' }] }),
      diff: async () => 'diff --git a/tests/packs.test.ts b/tests/packs.test.ts\n+x\n',
    });
    const byJob = await ciSubject(forge, 'o/r', { job: '7' });
    expect(byJob.ref).toBe('o/r job 7');
    expect(byJob.state['pull_request']).toEqual({ number: 3, title: 'Feat 3', branch: 'feat/3', files: [{ path: 'tests/packs.test.ts', additions: 1, deletions: 0 }] });
    expect(byJob.facts['has_pull']).toBe(true);
    const byRun = await ciSubject(forge, 'o/r', { run: '3' });
    expect(byRun.ref).toBe('o/r job 7');
    expect(calls).toEqual(['log 7', 'jobs 3', 'jobs 3', 'log 7']);
    await expect(ciSubject(forge, undefined, { job: '7' })).rejects.toThrow(/no repository/);
    await expect(ciSubject(fakeForge(), 'o/r', { run: '3' })).rejects.toThrow(/no failed job/);
    expect((await ciSubject(fakeForge(), 'o/r', { text: 'boom' })).state['pull_request']).toBeNull();
  });

  describe('an aggregate job that failed because a job it needs failed', () => {
    // mach's run 35781279928: docs failed, gate needs every job and failed because docs did
    const jobs = fillNeeds(
      MACH_JOBS.map((j) => ({ id: String(j.id), name: j.name, run: String(j.run_id), sha: j.head_sha, done: true, conclusion: j.conclusion, ok: j.conclusion !== 'failure', url: j.html_url })),
      workflowJobs(MACH_CI)!,
    );
    const id = (name: string): string => jobs.find((j) => j.name === name)!.id;
    const logs: string[] = [];
    const forge = (over: Parameters<typeof fakeForge>[0] = {}) =>
      fakeForge({
        jobs: async () => jobs,
        jobLog: async (_r, job) => {
          logs.push(job);
          const name = jobs.find((j) => j.id === job)!.name;
          return { job: name, run: String(MACH_RUN), sha: 'abc', url: `u${job}`, steps: [{ name: 'Run it', ok: false, text: `${name} broke\n##[error]Process completed with exit code 1.` }] };
        },
        ...over,
      });

    it('reads a run through the job that failed on its own and names the aggregate as downstream', async () => {
      logs.length = 0;
      const subject = await ciSubject(forge(), 'o/r', { run: String(MACH_RUN) });
      expect(subject.ref).toBe(`o/r job ${id('docs')}`);
      expect(subject.state['job']).toBe('docs');
      expect(subject.facts['followed']).toEqual(['gate: failed because docs failed']);
      expect(logs).toEqual([id('docs')]);
      const report = await runPack(BUILTIN_PACKS['ci']!, subject, reader, DEFAULT_CONFIG);
      expect(report.mechanical).toContainEqual({ check: 'log.followed', severity: 'info', message: 'gate: failed because docs failed' });
    });

    it('follows the aggregate named by its job id to the job that failed, and says so', async () => {
      logs.length = 0;
      const subject = await ciSubject(forge(), 'o/r', { job: id('gate') });
      expect(subject.ref).toBe(`o/r job ${id('docs')}`);
      expect(subject.state['job']).toBe('docs');
      expect(subject.facts['followed']).toEqual(['gate: failed because docs failed, followed to docs']);
      expect(logs).toEqual([id('gate'), id('docs')]);
    });

    it('follows through the downstream jobs between, and names every job that failed on its own but the one judged', async () => {
      // build x86_64-linux failed, docs was cancelled for it, and a test leg whose needs are unknown failed on its own
      const chain = jobs.map((j) =>
        j.name === 'build x86_64-linux' ? { ...j, conclusion: 'failure', ok: false }
        : j.name === 'docs' ? { ...j, conclusion: 'cancelled' }
        : j.name === 'test x86_64-windows' ? { ...j, conclusion: 'failure', ok: false, needs: undefined }
        : j,
      );
      const subject = await ciSubject(forge({ jobs: async () => chain }), 'o/r', { job: id('gate') });
      expect(subject.state['job']).toBe('build x86_64-linux');
      expect(subject.facts['followed']).toEqual([
        'gate: failed because build x86_64-linux failed, docs was cancelled and test x86_64-windows failed, followed to build x86_64-linux and test x86_64-windows',
        `test x86_64-windows: failed on its own, not judged here (job:${id('test x86_64-windows')})`,
      ]);
      // a chain the aggregate does not need directly: gate needs docs alone, docs needs the build
      const job = (n: string, needs: string[], conclusion: string): Job => ({ id: n, name: n, run: '1', sha: 'abc', url: n, done: true, conclusion, ok: false, needs });
      const short = [job('build', [], 'failure'), job('docs', ['build'], 'failure'), job('gate', ['docs'], 'failure')];
      const followed = await ciSubject(fakeForge({ jobs: async () => short, jobLog: async (_r, n) => ({ job: n, run: '1', sha: '', url: n, steps: [] }) }), 'o/r', { job: 'gate' });
      expect(followed.state['job']).toBe('build');
      expect(followed.facts['followed']).toEqual(['gate: failed because docs failed, followed to build']);
      const byRun = await ciSubject(fakeForge({ jobs: async () => short, jobLog: async (_r, n) => ({ job: n, run: '1', sha: '', url: n, steps: [] }) }), 'o/r', { run: '1' });
      expect(byRun.state['job']).toBe('build');
      expect(byRun.facts['followed']).toEqual(['docs: failed because build failed', 'gate: failed because docs failed']);
    });

    it('judges a job whose needs cannot be resolved as before', async () => {
      logs.length = 0;
      const unresolved = jobs.map(({ needs: _, ...j }) => j);
      const byRun = await ciSubject(forge({ jobs: async () => unresolved }), 'o/r', { run: String(MACH_RUN) });
      expect(byRun.state['job']).toBe('docs');
      expect(byRun.facts['followed']).toEqual([`gate: failed on its own, not judged here (job:${id('gate')})`]);
      const byJob = await ciSubject(forge({ jobs: async () => unresolved }), 'o/r', { job: id('gate') });
      expect(byJob.state['job']).toBe('gate');
      expect(byJob.facts['followed']).toEqual([]);
      expect(logs).toEqual([id('docs'), id('gate')]);
    });
  });
});
