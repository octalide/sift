import { describe, expect, it } from 'vitest';
import { applyDecisions, buildState, collectCalls, compact, reduction, type Message } from '../src/compact/compact.ts';
import type { Judge, Questions } from '../src/judge/types.ts';
import { chunkText, prune, PRUNE_DEFAULTS } from '../src/prune/prune.ts';

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

const big = 'export const a = 1;\n'.repeat(60);

function transcript(): Message[] {
  return [
    { role: 'user', text: 'Fix the failing test.', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: big, isError: false }], handle: 'h2' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't2', tool: 'Bash', input: { command: 'npm test' } }], handle: 'h3' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't2', text: 'FAIL expected 2 to be 3', isError: true }], handle: 'h4' },
    { role: 'assistant', text: 'Fixing now.', toolUses: [], handle: 'h5' },
    { role: 'user', text: 'go ahead', toolUses: [], handle: 'h6' },
  ];
}

describe('compaction', () => {
  it('pairs calls with results outside the pinned window', () => {
    const calls = collectCalls(transcript(), 5);
    expect(calls.map((c) => c.id)).toEqual(['t1', 't2']);
    expect(calls[0]!.resultIndex).toBe(2);
  });

  it('drops stale calls, truncates unneeded results, and keeps text and handles', async () => {
    const messages = transcript();
    const result = await compact(messages, judgeBy((id) => (id.endsWith('_t1') ? 0.1 : id === 'full_t2' ? 0.2 : 0.9)), {
      keepThreshold: 0.5,
      pinRecent: 2,
      truncateHead: 5,
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.decisions.map((d) => `${d.id}:${d.action}`)).toEqual(['t1:drop', 't2:truncate']);
    expect(result.messages.map((m) => m.handle ?? 'rebuilt')).toEqual(['h0', 'h3', 'rebuilt', 'h5', 'h6']);
    expect(result.messages.find((m) => m.toolResults)?.toolResults?.[0]?.text).toMatch(/^FAIL \n\[sift: /);
    expect(result.messages.some((m) => m.toolUses.some((u) => u.tool_use_id === 't1'))).toBe(false);
    expect(reduction(result)).toBeGreaterThan(0.5);
  });

  it('returns the transcript untouched when the judge fails', async () => {
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'unavailable', message: 'down', backend: 'off' }) };
    const result = await compact(transcript(), off, { keepThreshold: 0.5, pinRecent: 2, truncateHead: 5, maxStateTokens: 1000, maxRequestTokens: 2000 });
    expect(result.error).toMatch(/down/);
    expect(result.messages).toHaveLength(7);
  });

  it('shrinks the state once when the server rejects its size', async () => {
    const seen: number[] = [];
    const judge: Judge = {
      name: 'fake',
      ask: async (state, questions: Questions) => {
        const size = JSON.stringify(state).length;
        seen.push(size);
        if (seen.length === 1) return { ok: false, reason: 'unavailable', message: 'http 400: state too large', backend: 'fake', status: 400 };
        return { ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, p: 0 }])) };
      },
    };
    const result = await compact(transcript(), judge, { keepThreshold: 0.5, pinRecent: 2, truncateHead: 50, maxStateTokens: 4000, maxRequestTokens: 30_000 });
    expect(result.error).toBeUndefined();
    expect(seen.length).toBe(2);
    expect(result.decisions.every((d) => d.action === 'drop')).toBe(true);
  });

  it('keeps a needed result even when the call alone scores low', async () => {
    const result = await compact(transcript(), judgeBy((id) => (id === 'keep_t1' ? 0.1 : 0.9)), { keepThreshold: 0.5, pinRecent: 2, truncateHead: 5, maxStateTokens: 25_000, maxRequestTokens: 30_000 });
    expect(result.decisions.map((d) => `${d.id}:${d.action}`)).toEqual(['t1:keep', 't2:keep']);
  });

  it('shrinks a long history in stages and keeps every call visible', () => {
    const messages: Message[] = [{ role: 'user', text: 'Refactor the parser.', toolUses: [], handle: 'h0' }];
    for (let n = 1; n <= 300; n++) {
      messages.push({ role: 'assistant', text: n % 7 === 0 ? 'Looking at the tokenizer. '.repeat(40) : '', toolUses: [{ tool_use_id: `u${n}`, tool: 'Read', input: { file_path: `src/file${n}.ts`, note: 'x'.repeat(300) } }] });
      messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${n}`, text: big, isError: false }] });
    }
    messages.push({ role: 'user', text: 'now finish it', toolUses: [] });
    const pinnedFrom = messages.length - 2;
    const calls = collectCalls(messages, pinnedFrom);
    expect(calls).toHaveLength(300);
    const full = buildState(messages, calls, 1_000_000, pinnedFrom);
    expect(full.stage).toBe('full');
    const merged = buildState(messages, calls, 12_000, pinnedFrom);
    expect(merged.stage).toBe('old calls merged');
    expect(merged.fits).toBe(true);
    const tight = buildState(messages, calls, 7_000, pinnedFrom);
    expect(tight.stage).toBe('old inputs dropped');
    expect(tight.fits).toBe(true);
    expect(tight.tokens).toBeLessThan(merged.tokens);
    for (const state of [merged, tight]) {
      const text = JSON.stringify(state.state);
      for (const c of calls) expect(text).toContain(`${c.label} Read`);
    }
    const none = buildState(messages, calls, 500, pinnedFrom);
    expect(none.fits).toBe(false);
  });

  it('never drops a message that still holds text', () => {
    const messages = transcript();
    messages[1]!.text = 'reading';
    const calls = collectCalls(messages, 5);
    const out = applyDecisions(messages, calls, [{ id: 't1', tool: 'Read', keep: 0, full: 0, action: 'drop' }], 5);
    expect(out[1]).toMatchObject({ text: 'reading', toolUses: [] });
    expect(out[1]!.handle).toBeUndefined();
  });
});

describe('pruning', () => {
  const noisy = [...Array(200).keys()].map((i) => (i === 120 ? 'Error: boom at line 120' : `progress ${i}%`)).join('\n');

  it('protects the first, last and diagnostic chunks and drops the rest when unneeded', async () => {
    const result = await prune(noisy, { tool: 'Bash', input: { command: 'make' }, task: 'build it', archivePath: '/tmp/x.txt' }, judgeBy(() => 0.1), { ...PRUNE_DEFAULTS, floorTokens: 10, chunkLines: 20 });
    expect(result.chunks).toBe(10);
    expect(result.kept).toBe(3);
    expect(result.text).toContain('Error: boom');
    expect(result.text).toContain('progress 0%');
    expect(result.text).toContain('progress 199%');
    expect(result.text).toMatch(/\[sift: lines 21-120 \(100 lines\) omitted .* \/tmp\/x\.txt\]/);
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
    expect(chunks[0]!.to).toBe(3);
    expect(chunkText(Array(10_000).fill('l').join('\n'), 25, 160).length).toBeLessThanOrEqual(160);
  });
});
