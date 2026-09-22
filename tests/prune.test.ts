import { describe, expect, it } from 'vitest';
import type { Decision } from '../src/judge/index.ts';
import type { Judge, Questions } from '../src/judge/types.ts';
import { pruneCall, type PruneCallOptions } from '../src/prune/call.ts';
import { pathsIn, PruneLoops, type PruneCall } from '../src/prune/loops.ts';
import { PRUNE_DEFAULTS } from '../src/prune/prune.ts';

const OPTIONS: PruneCallOptions = { ...PRUNE_DEFAULTS, floorTokens: 10, chunkLines: 20, tools: ['Bash', 'Read'], shadow: false };
const noisy = [...Array(200).keys()].map((i) => `progress ${i}%`).join('\n');

// drops every chunk it is asked about, and keeps the task each request was judged against
function dropping(): Judge & { tasks: string[] } {
  const tasks: string[] = [];
  return {
    name: 'fake',
    tasks,
    ask: async (state, questions: Questions) => {
      tasks.push(String((state as { task?: unknown }).task));
      return { ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, p: 0 }])) };
    },
  };
}

// a judge that fails the test if prune asks it anything
const untouchable: Judge = {
  name: 'untouchable',
  ask: async () => {
    throw new Error('judge called');
  },
};

function sink() {
  const decisions: { action: string; extra: Partial<Decision> }[] = [];
  return { decisions, record: (action: string, extra: Partial<Decision>) => void decisions.push({ action, extra }), toast: () => {} };
}

const bash = (command: string, agentId?: string): PruneCall => ({ tool: 'Bash', input: { tool: 'Bash', command }, agentId });
const read = (input: Record<string, unknown>, agentId?: string): PruneCall => ({ tool: 'Read', input: { tool: 'Read', ...input }, agentId });
const bashOut = () => ({ result: { stdout: noisy, stderr: '' } });
const readOut = () => ({ result: { type: 'text', file: { filePath: '/x', content: noisy } } });

function stdout(r: { result?: unknown }): string {
  return (r.result as { stdout: string }).stdout;
}

function content(r: { result?: unknown }): string {
  return (r.result as { file: { content: string } }).file.content;
}

describe('prune per loop', () => {
  it('judges a subagent call against the prompt it was spawned with, not the main loop task', async () => {
    const loops = new PruneLoops();
    loops.submitted('composer', 'triage the backlog');
    loops.spawned('a1', 'build the watch registry');
    const judge = dropping();
    const r = await pruneCall(bash('make', 'a1'), bashOut(), loops, judge, OPTIONS, sink());
    expect(stdout(r)).toContain('omitted as not needed');
    expect(judge.tasks).toEqual(['build the watch registry']);
    await pruneCall(bash('make'), bashOut(), loops, judge, OPTIONS, sink());
    expect(judge.tasks[1]).toBe('triage the backlog');
  });

  it('keeps the person prompt as the main task when a plugin prompt or a notification arrives', async () => {
    const loops = new PruneLoops();
    loops.submitted('composer', 'fix the flaky test');
    loops.submitted('plugin', '[sift watch octalide/sift]\nci settled failure: pr #3');
    loops.submitted('task-notification', 'agent a1 completed');
    loops.submitted('peer', 'another session says hi');
    expect(loops.task(undefined)).toBe('fix the flaky test');
    loops.submitted('bridge', 'now the docs');
    expect(loops.task(undefined)).toBe('now the docs');
  });

  it('passes a loop with no recorded task untouched', async () => {
    const out = sink();
    const r = await pruneCall(bash('make', 'unknown'), bashOut(), new PruneLoops(), untouchable, OPTIONS, out);
    expect(stdout(r)).toBe(noisy);
    expect(out.decisions).toEqual([{ action: 'none', extra: { digest: 'Bash: no task recorded for this loop' } }]);
  });
});

describe('prune back-off', () => {
  const loopsWith = (task: string) => {
    const loops = new PruneLoops();
    loops.spawned('a1', task);
    return loops;
  };

  it('passes a Read with offset or limit untouched with no judge call', async () => {
    const loops = loopsWith('review the code');
    for (const input of [{ file_path: '/src/a.ts', offset: 10 }, { file_path: '/src/a.ts', limit: 300 }]) {
      const out = sink();
      const r = await pruneCall(read(input, 'a1'), readOut(), loops, untouchable, OPTIONS, out);
      expect(content(r)).toBe(noisy);
      expect(out.decisions[0]).toEqual({ action: 'none', extra: { digest: 'Read: targeted read (offset or limit)' } });
    }
  });

  it('passes a repeat Read of a pruned path and a rerun of a pruned command untouched for the rest of the task', async () => {
    const loops = loopsWith('review the code');
    const first = await pruneCall(read({ file_path: '/src/a.ts' }, 'a1'), readOut(), loops, dropping(), OPTIONS, sink());
    expect(content(first)).toContain('omitted as not needed');
    const out = sink();
    const again = await pruneCall(read({ file_path: '/src/a.ts' }, 'a1'), readOut(), loops, untouchable, OPTIONS, out);
    expect(content(again)).toBe(noisy);
    expect(out.decisions[0]!.extra.digest).toBe('Read: path pruned earlier in this task');

    await pruneCall(bash('npm test', 'a1'), bashOut(), loops, dropping(), OPTIONS, sink());
    const rerun = await pruneCall(bash(' npm test ', 'a1'), bashOut(), loops, untouchable, OPTIONS, sink());
    expect(stdout(rerun)).toBe(noisy);

    // another loop never pruned that path, so it is judged there
    loops.spawned('a2', 'review the code');
    const other = await pruneCall(read({ file_path: '/src/a.ts' }, 'a2'), readOut(), loops, dropping(), OPTIONS, sink());
    expect(content(other)).toContain('omitted as not needed');

    // a new task starts clean
    loops.spawned('a1', 'something else');
    const fresh = await pruneCall(read({ file_path: '/src/a.ts' }, 'a1'), readOut(), loops, dropping(), OPTIONS, sink());
    expect(content(fresh)).toContain('omitted as not needed');
  });

  it('does not count a shadow prune as pruned', async () => {
    const loops = loopsWith('review the code');
    await pruneCall(read({ file_path: '/src/a.ts' }, 'a1'), readOut(), loops, dropping(), { ...OPTIONS, shadow: true }, sink());
    const judge = dropping();
    await pruneCall(read({ file_path: '/src/a.ts' }, 'a1'), readOut(), loops, judge, OPTIONS, sink());
    expect(judge.tasks).toHaveLength(1);
  });

  it('passes a Read of a path the task names untouched', async () => {
    const loops = loopsWith('Read the dumps in full: `issues/open.json`, /tmp/x/closed.json and hooks/sift.ts:138-145, then README.md.');
    for (const file_path of ['/work/sift/issues/open.json', '/tmp/x/closed.json', '/work/sift/hooks/sift.ts', '/work/sift/README.md']) {
      const out = sink();
      const r = await pruneCall(read({ file_path }, 'a1'), readOut(), loops, untouchable, OPTIONS, out);
      expect(content(r)).toBe(noisy);
      expect(out.decisions[0]!.extra.digest).toBe('Read: path named in the task');
    }
    const judge = dropping();
    await pruneCall(read({ file_path: '/work/sift/src/other.ts' }, 'a1'), readOut(), loops, judge, OPTIONS, sink());
    await pruneCall(read({ file_path: '/work/sift/NOT-README.md' }, 'a1'), readOut(), loops, judge, OPTIONS, sink());
    expect(judge.tasks).toHaveLength(2);
  });

  it('finds the path-like words of a task', () => {
    expect(pathsIn('see hooks/sift.ts:138-145, and ./src/a.ts. Also https://example.com/x.html and the dir src/prune/')).toEqual(['hooks/sift.ts', 'src/a.ts']);
  });
});

describe('prune opt-out', () => {
  it('keeps a Bash command marked # sift: full whole', async () => {
    const loops = new PruneLoops();
    loops.submitted('composer', 'read the log');
    const out = sink();
    const r = await pruneCall(bash('cat build.log # sift: full'), bashOut(), loops, untouchable, OPTIONS, out);
    expect(stdout(r)).toBe(noisy);
    expect(out.decisions[0]!.extra.digest).toBe('Bash: command marked # sift: full');
  });

  it('turns prune off for the calling loop alone until its next task', async () => {
    const loops = new PruneLoops();
    loops.submitted('composer', 'triage');
    loops.spawned('a1', 'read every issue');
    expect(loops.control('a1', 'off')).toBe('prune off for this loop until its next task');
    for (let i = 0; i < 3; i++) expect(stdout(await pruneCall(bash(`cat dump${i}`, 'a1'), bashOut(), loops, untouchable, OPTIONS, sink()))).toBe(noisy);
    // the main loop still prunes
    expect(stdout(await pruneCall(bash('cat dump'), bashOut(), loops, dropping(), OPTIONS, sink()))).toContain('omitted');
    loops.control('a1', 'on');
    expect(stdout(await pruneCall(bash('cat other', 'a1'), bashOut(), loops, dropping(), OPTIONS, sink()))).toContain('omitted');

    loops.control(undefined, 'off');
    expect(stdout(await pruneCall(bash('cat x'), bashOut(), loops, untouchable, OPTIONS, sink()))).toBe(noisy);
    loops.submitted('composer', 'next task');
    expect(stdout(await pruneCall(bash('cat y'), bashOut(), loops, dropping(), OPTIONS, sink()))).toContain('omitted');
  });

  it('turns prune off for a number of outputs over the floor', async () => {
    const loops = new PruneLoops();
    loops.spawned('a1', 'read');
    loops.control('a1', 'off', 2);
    // under the floor, so it neither is pruned nor spends one
    await pruneCall(bash('echo hi', 'a1'), { result: { stdout: 'hi' } }, loops, untouchable, OPTIONS, sink());
    expect(stdout(await pruneCall(bash('cat a', 'a1'), bashOut(), loops, untouchable, OPTIONS, sink()))).toBe(noisy);
    expect(stdout(await pruneCall(bash('cat b', 'a1'), bashOut(), loops, untouchable, OPTIONS, sink()))).toBe(noisy);
    expect(stdout(await pruneCall(bash('cat c', 'a1'), bashOut(), loops, dropping(), OPTIONS, sink()))).toContain('omitted');
  });

  it('names the opt-out in the omission note', async () => {
    const loops = new PruneLoops();
    loops.submitted('composer', 'review');
    const r = await pruneCall(read({ file_path: '/src/a.ts' }), readOut(), loops, dropping(), OPTIONS, sink());
    expect(content(r)).toContain('re-read /src/a.ts with offset 21 limit 180, or call mcp__sift__prune off to read files whole]');
    const b = await pruneCall(bash('make'), bashOut(), loops, dropping(), OPTIONS, sink());
    expect(stdout(b)).toContain('rerun the command for the full output, or end a command with # sift: full to keep its output whole]');
  });
});

// drops exactly the chunks named, keeps every other
function droppingChunks(drop: number[]): Judge {
  return {
    name: 'fake',
    ask: async (_state, questions: Questions) => ({ ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, p: drop.includes(Number(k.slice(k.lastIndexOf('_') + 1))) ? 0 : 1 }])) }),
  };
}

describe('prune Read only at its tail', () => {
  const numbered = [...Array(200).keys()].map((i) => `file line ${i + 1}`).join('\n');
  const numberedOut = () => ({ result: { type: 'text', file: { filePath: '/src/a.ts', content: numbered, numLines: 200, startLine: 1, totalLines: 200 } } });
  const file = (r: { result?: unknown }) => (r.result as { file: { content: string; numLines: number; startLine: number } }).file;
  const loops = () => {
    const l = new PruneLoops();
    l.submitted('composer', 'review');
    return l;
  };
  // every line the engine will number as startLine + i must be that file line, the trailing note aside
  const numberedTrue = (r: { result?: unknown }) => {
    const f = file(r);
    f.content.split('\n').forEach((l, i) => {
      if (!l.startsWith('[sift:')) expect(l).toBe(`file line ${f.startLine + i}`);
    });
  };

  it('passes a Read whose low chunk sits in the middle whole, since a gap would misnumber the lines after it', async () => {
    const s = sink();
    const r = await pruneCall(read({ file_path: '/src/a.ts' }), numberedOut(), loops(), droppingChunks([4]), OPTIONS, s);
    expect(file(r).content).toBe(numbered);
    expect(file(r).numLines).toBe(200);
    numberedTrue(r);
    expect(s.decisions[0]).toEqual({ action: 'none', extra: { digest: 'Read: gap would misnumber lines' } });
  });

  it('prunes a low tail to the kept prefix and a trailing note, with numLines the lines returned', async () => {
    const r = await pruneCall(read({ file_path: '/src/a.ts' }), numberedOut(), loops(), droppingChunks([8, 9]), OPTIONS, sink());
    const lines = file(r).content.split('\n');
    expect(lines).toHaveLength(161);
    expect(file(r).numLines).toBe(161);
    expect(lines[160]).toContain('[sift: lines 161-200 (40 lines) omitted');
    numberedTrue(r);
  });

  it('keeps a low middle chunk in front of a kept one and omits only the run after the last kept chunk', async () => {
    const r = await pruneCall(read({ file_path: '/src/a.ts' }), numberedOut(), loops(), droppingChunks([3, 7, 8, 9]), OPTIONS, sink());
    const lines = file(r).content.split('\n');
    expect(lines).toHaveLength(141);
    expect(lines.filter((l) => l.startsWith('[sift:'))).toEqual([expect.stringContaining('lines 141-200 (60 lines)')]);
    numberedTrue(r);
  });

  it('still omits a Bash output in the middle, which has no gutter', async () => {
    const r = await pruneCall(bash('make'), bashOut(), loops(), droppingChunks([4]), OPTIONS, sink());
    expect(stdout(r)).toContain('[sift: lines 81-100 (20 lines) omitted');
  });
});
