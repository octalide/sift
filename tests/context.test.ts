import { describe, expect, it } from 'vitest';
import type { Judge, Questions } from '../src/judge/types.ts';
import { chunkText, omissionNote, prune, PRUNE_DEFAULTS } from '../src/prune/prune.ts';

function judgeBy(fn: (id: string) => number): Judge {
  return {
    name: 'fake',
    ask: async (_state, questions: Questions) => ({
      ok: true,
      backend: 'fake',
      latencyMs: 1,
      answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, p: fn(k) }])),
    }),
  };
}

describe('pruning', () => {
  const noisy = [...Array(200).keys()].map((i) => (i === 120 ? 'Error: boom at line 120' : `progress ${i}%`)).join('\n');

  it('protects the first, last and diagnostic chunks and drops the rest when unneeded', async () => {
    const result = await prune(noisy, { tool: 'Bash', input: { command: 'make' }, task: 'build it' }, judgeBy(() => 0.1), { ...PRUNE_DEFAULTS, floorTokens: 10, chunkLines: 20 });
    expect(result.chunks).toBe(10);
    expect(result.kept).toBe(3);
    expect(result.text).toContain('Error: boom');
    expect(result.text).toContain('progress 0%');
    expect(result.text).toContain('progress 199%');
    expect(result.text).toContain('[sift: lines 21-120 (100 lines) omitted as not needed for the current task, rerun the command for the full output]');
    expect(result.text.split('\n').filter((l) => l.startsWith('[sift:'))).toHaveLength(2);
  });

  it('notes a dropped Read range in file lines with the call to read it back', async () => {
    const result = await prune(noisy, { tool: 'Read', input: { file_path: '/src/a.ts', offset: 100, limit: 200 }, task: 'find the bug' }, judgeBy(() => 0.1), { ...PRUNE_DEFAULTS, floorTokens: 10, chunkLines: 20 });
    expect(result.text).toContain('[sift: lines 120-219 (100 lines) omitted as not needed for the current task, re-read /src/a.ts with offset 120 limit 100]');
    const plain = omissionNote({ tool: 'Read', input: { file_path: '/src/a.ts' }, task: '' });
    expect(plain(21, 40)).toBe('[sift: lines 21-40 (20 lines) omitted as not needed for the current task, re-read /src/a.ts with offset 21 limit 20]');
  });

  it('passes short output and judge failures through untouched', async () => {
    const short = await prune('hi', { tool: 'Bash', input: {}, task: '' }, judgeBy(() => 0), PRUNE_DEFAULTS);
    expect(short.skipped).toBe('under floor');
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'unavailable', message: 'down', backend: 'off' }) };
    const failed = await prune(noisy, { tool: 'Bash', input: {}, task: '' }, off, { ...PRUNE_DEFAULTS, floorTokens: 10 });
    expect(failed.error).toMatch(/down/);
    expect(failed.text).toBe(noisy);
  });

  it('splits over-long lines and caps chunk count', () => {
    const chunks = chunkText('x'.repeat(5000), 25, 160);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.to).toBe(1);
    expect(chunkText(Array(10_000).fill('l').join('\n'), 25, 160).length).toBeLessThanOrEqual(160);
  });

  it('bounds chunks by source line when a split line straddles a chunk boundary', async () => {
    const long = 'y'.repeat(5000);
    const text = [...Array(24).keys()].map((i) => `l${i}`).concat(long, [...Array(30).keys()].map((i) => `m${i}`)).join('\n');
    const chunks = chunkText(text, 25, 160);
    expect(chunks.map((c) => [c.from, c.to, c.continues])).toEqual([[1, 25, false], [25, 48, true], [49, 55, false]]);
    expect(chunks[0]!.text.endsWith('\n' + 'y'.repeat(2000))).toBe(true);
    expect(chunks[1]!.text.startsWith('y'.repeat(3000) + '\nm0')).toBe(true);
    const result = await prune(text, { tool: 'Bash', input: {}, task: '' }, judgeBy(() => 1), { ...PRUNE_DEFAULTS, floorTokens: 10 });
    expect(result.text).toBe(text);
  });

  it('notes real line numbers around a 5000-character line in Read output', async () => {
    const long = 'z'.repeat(5000);
    const text = [...Array(200).keys()].map((i) => (i === 120 ? long : `line ${i}`)).join('\n');
    const context = { tool: 'Read', input: { file_path: '/src/a.ts', offset: 100, limit: 200 }, task: 'find the bug' };
    const result = await prune(text, context, judgeBy((k) => (k === 'needed_6' ? 1 : 0)), { ...PRUNE_DEFAULTS, floorTokens: 10, chunkLines: 20 });
    expect(result.chunks).toBe(11);
    expect(result.text).toContain('[sift: lines 120-219 (100 lines) omitted as not needed for the current task, re-read /src/a.ts with offset 120 limit 100]');
    expect(result.text).toContain('[sift: lines 238-297 (60 lines) omitted as not needed for the current task, re-read /src/a.ts with offset 238 limit 60]');
    const lines = result.text.split('\n');
    expect(lines).toHaveLength(42);
    expect(lines[21]).toBe(long);
    expect(lines[22]).toBe('line 121');
  });
});
