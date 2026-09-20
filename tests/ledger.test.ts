import { describe, expect, it } from 'vitest';
import type { Message } from '../src/compact/compact.ts';
import { BUILTIN_SUMMARY_PREFIX, compactWithLedger, isSummary, LEDGER_MARK, ledgerMessage, type LedgerCompactOptions } from '../src/compact/ledger.ts';
import type { Judge, Questions } from '../src/judge/types.ts';
import { estimateTokensOf } from '../src/tokens.ts';

const OPTIONS: Omit<LedgerCompactOptions, 'ledger'> = {
  keepThreshold: 0.5,
  pinRecent: 4,
  truncateHead: 20,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  ledgerPath: '/state/ledger.md',
};

// answers in_flight from the ledger text and keep/full from the call's input
function judgeOf(inFlight: (ledger: string) => number, keep: (input: string) => number, seen: Questions[] = []): Judge {
  return {
    name: 'fake',
    ask: async (state, questions: Questions) => {
      seen.push(questions);
      const s = state as { ledger?: string; history?: { tool_calls?: { id: string; input: string }[] }[] };
      const inputs = new Map<string, string>();
      for (const e of s.history ?? []) for (const c of e.tool_calls ?? []) if (typeof c === 'object') inputs.set(c.id, c.input);
      const answers = Object.fromEntries(
        Object.keys(questions).map((k) => {
          const p = k === 'in_flight' ? inFlight(s.ledger ?? '') : keep(inputs.get(k.replace(/^(keep|full)_/, '')) ?? '');
          return [k, { type: 'noul' as const, p }];
        }),
      );
      return { ok: true, backend: 'fake', latencyMs: 1, answers };
    },
  };
}

const big = 'line of output\n'.repeat(80);
let ids = 0;

function call(tool: string, input: Record<string, unknown>, result = big): Message[] {
  const id = `t${++ids}`;
  return [
    { role: 'assistant', text: `Calling ${tool}.`, toolUses: [{ tool_use_id: id, tool, input }], handle: `h${id}a` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: result, isError: false }], handle: `h${id}r` },
  ];
}

const prompt = (text: string): Message => ({ role: 'user', text, toolUses: [], handle: `p${++ids}` });
const say = (text: string): Message => ({ role: 'assistant', text, toolUses: [], handle: `s${++ids}` });

describe('ledger compaction', () => {
  it('drops every prior summary and inserts the ledger once', async () => {
    const messages: Message[] = [
      { role: 'user', text: `${BUILTIN_SUMMARY_PREFIX} that ran out of context.\n\nSummary: old stuff`, toolUses: [], handle: 's1' },
      prompt('TASK d-1: fix #7'),
      ...call('Read', { file_path: 'a.ts', item: 7 }),
      ledgerMessage('# ledger\n\n## in flight\n- #7 building', '/state/ledger.md'),
      say('Resuming #7.'),
      ...call('Bash', { command: 'npm test', item: 7 }),
      say('Tests pass.'),
      ...call('Read', { file_path: 'b.ts', item: 7 }),
    ];
    expect(messages.filter(isSummary)).toHaveLength(2);
    const result = await compactWithLedger(messages, judgeOf(() => 0.9, (input) => (input.includes('npm test') ? 0.9 : 0.1)), {
      ...OPTIONS,
      ledger: '# ledger\n\n## in flight\n- #7 building, tests green, docs next',
    });
    expect(result.error).toBeUndefined();
    expect(result.summariesDropped).toBe(2);
    expect(result.inFlight).toBe(true);
    const summaries = result.messages.filter(isSummary);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.text).toContain('docs next');
    expect(result.messages[0]).toBe(summaries[0]);
    // the prompt stays, the narration between items goes, the judged call stays without its narration
    expect(result.messages.some((m) => m.text === 'TASK d-1: fix #7')).toBe(true);
    expect(result.messages.some((m) => m.text === 'Resuming #7.')).toBe(false);
    const kept = result.messages.find((m) => m.toolUses.some((u) => u.tool === 'Bash'));
    expect(kept?.text).toBe('');
    expect(kept?.handle).toBeUndefined();
    expect(result.messages.some((m) => m.toolUses.some((u) => u.input['file_path'] === 'a.ts'))).toBe(false);
    // the pinned tail is untouched
    expect(result.messages.slice(-4).map((m) => m.handle)).toEqual(messages.slice(-4).map((m) => m.handle));
    expect(result.residueTokens).toBeGreaterThan(0);
    expect(result.residueTokens).toBeLessThan(estimateTokensOf(messages.slice(2, 4)));
  });

  it('skips the judge over the transcript when the ledger says nothing is mid-item', async () => {
    const seen: Questions[] = [];
    const messages: Message[] = [
      prompt('TASK d-1: fix #7'),
      ...call('Read', { file_path: 'a.ts' }),
      ...call('Bash', { command: 'npm test' }),
      say('DONE #7.'),
      prompt('[sift watch] issue #8 opened'),
      ...call('Bash', { command: 'gh issue view 8' }),
      ...call('Read', { file_path: 'c.ts' }),
    ];
    const ledger = '# ledger\n\n## in flight\n(none)';
    const result = await compactWithLedger(messages, judgeOf(() => 0.05, () => 0.9, seen), { ...OPTIONS, ledger });
    expect(result.error).toBeUndefined();
    expect(result.inFlight).toBe(false);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!)).toEqual(['in_flight']);
    expect(result.requests).toBe(1);
    const watchPrompt = messages.find((m) => m.text.startsWith('[sift watch]'))!;
    expect(result.messages.map((m) => m.handle ?? 'ledger')).toEqual(['ledger', watchPrompt.handle, ...messages.slice(-4).map((m) => m.handle)]);
    expect(result.messages[1]!.text).toBe('[sift watch] issue #8 opened');
    expect(result.residueTokens).toBe(0);
  });

  it('asks nothing at all over an empty ledger', async () => {
    const seen: Questions[] = [];
    const result = await compactWithLedger([prompt('hello'), ...call('Read', { file_path: 'a.ts' }), say('read it')], judgeOf(() => 1, () => 1, seen), { ...OPTIONS, ledger: '  \n' });
    expect(seen).toHaveLength(0);
    expect(result.requests).toBe(0);
    expect(result.messages[0]!.text).toContain('(empty)');
  });

  it('falls back whole when the judge fails mid-item', async () => {
    const down: Judge = { name: 'down', ask: async () => ({ ok: false, reason: 'unavailable', message: 'offline', backend: 'down' }) };
    const messages = [prompt('TASK'), ...call('Read', { file_path: 'a.ts' }), ...call('Read', { file_path: 'b.ts' }), ...call('Read', { file_path: 'c.ts' })];
    const result = await compactWithLedger(messages, down, { ...OPTIONS, ledger: '- #7 building' });
    expect(result.error).toMatch(/offline/);
    expect(result.messages).toBe(result.messages);
    expect(result.messages.map((m) => m.handle)).toEqual(messages.map((m) => m.handle));
  });

  // the mach shape: one long task prompt, then hours of tool calls with narration, watch deliveries and peer
  // messages between them, the ledger rewritten as items move, compaction firing every so many turns
  it('holds residue flat across five successive compactions', async () => {
    let item = 100;
    const ledgerFor = (n: number) => `# mach ledger\n\n## in flight\n- #${n} (feat/${n}, .wt/${n}): building, suite next.\n\n## queue\n- #${n + 1}\n- #${n + 2}`;
    const judge = judgeOf(
      () => 0.9,
      // the working set of the current item stays, everything from earlier items is stale
      (input) => (input.includes(`item:${item}`) ? 0.9 : 0.1),
    );
    let messages: Message[] = [prompt('TASK delegator-298: resume from your ledger. Order: #100 -> #101 -> #102.'), say('Name matches. Arming the watcher and orienting.')];
    const work = (n: number) => {
      const out: Message[] = [];
      for (let k = 0; k < 12; k++) {
        out.push(...call(k % 3 === 0 ? 'Bash' : 'Read', { file_path: `src/f${k}.ts`, note: `item:${n}` }));
        if (k % 4 === 0) out.push(say(`Looking at f${k} for #${n}. `.repeat(8)));
        if (k % 5 === 0) out.push(prompt(`[sift watch briar-systems/mach] issue #${n * 10 + k} opened: actionable 0.8`));
      }
      return out;
    };
    const residues: number[] = [];
    const sizes: number[] = [];
    for (let round = 0; round < 5; round++) {
      messages.push(...work(item), ...work(item), say(`DONE #${item}`), prompt(`TASK: next is #${item + 1}`));
      item += 1;
      messages.push(...work(item));
      const result = await compactWithLedger(messages, judge, { ...OPTIONS, pinRecent: 6, ledger: ledgerFor(item) });
      expect(result.error).toBeUndefined();
      expect(result.summariesDropped).toBe(round === 0 ? 0 : 1);
      expect(result.messages.filter(isSummary)).toHaveLength(1);
      residues.push(result.residueTokens);
      sizes.push(result.tokensAfter);
      messages = result.messages;
    }
    // every round keeps only the current item's working set, so the residue and the size settle and stay
    for (let i = 1; i < residues.length; i++) expect(residues[i]).toBeLessThanOrEqual(residues[1]! * 1.05 + 10);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[1]! * 1.05 + 10);
    expect(new Set(residues.slice(1)).size).toBeLessThanOrEqual(2);
  });
});

describe('ledger messages', () => {
  it('recognises its own and the engine summary, nothing else', () => {
    expect(isSummary(ledgerMessage('x', '/p'))).toBe(true);
    expect(isSummary({ role: 'user', text: `${BUILTIN_SUMMARY_PREFIX}.`, toolUses: [] })).toBe(true);
    expect(isSummary({ role: 'assistant', text: `${LEDGER_MARK} quoted`, toolUses: [] })).toBe(false);
    expect(isSummary({ role: 'user', text: 'plain prompt', toolUses: [] })).toBe(false);
    expect(isSummary({ role: 'user', text: LEDGER_MARK, toolUses: [], toolResults: [{ tool_use_id: 't', text: 'x', isError: false }] })).toBe(false);
  });
});
