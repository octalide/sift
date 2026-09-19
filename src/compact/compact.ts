import { bandOf } from '../judge/bands.ts';
import type { Judge, Questions } from '../judge/types.ts';
import { estimateTokens, estimateTokensOf, truncate } from '../tokens.ts';

export type ToolUse = {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  result?: unknown;
  isError?: boolean;
};

export type ToolResult = {
  tool_use_id: string;
  text: string;
  isError: boolean;
  result?: unknown;
};

export type Message = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
  handle?: string;
};

export type CompactOptions = {
  keepThreshold: number;
  pinRecent: number;
  truncateHead: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  instructions?: string;
};

export const COMPACT_DEFAULTS: CompactOptions = {
  keepThreshold: 0.5,
  pinRecent: 6,
  truncateHead: 300,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
};

export type Call = {
  id: string;
  tool: string;
  useIndex: number;
  resultIndex?: number;
  use: ToolUse;
  result?: ToolResult;
  chars: number;
};

export type CallDecision = { id: string; tool: string; keep: number; full: number; action: 'keep' | 'truncate' | 'drop' };

export type CompactResult = {
  messages: Message[];
  decisions: CallDecision[];
  charsBefore: number;
  charsAfter: number;
  requests: number;
  stateTokens: number;
  error?: string;
};

function messageChars(m: Message): number {
  return (
    m.text.length +
    m.toolUses.reduce((n, u) => n + JSON.stringify(u.input).length + (u.text?.length ?? 0), 0) +
    (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0)
  );
}

export function collectCalls(messages: readonly Message[], pinnedFrom: number): Call[] {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  messages.forEach((m, i) => {
    if (i === 0 || i >= pinnedFrom) return;
    for (const use of m.toolUses) {
      const call: Call = { id: use.tool_use_id, tool: use.tool, useIndex: i, use, chars: JSON.stringify(use.input).length };
      calls.push(call);
      byId.set(call.id, call);
    }
    for (const result of m.toolResults ?? []) {
      const call = byId.get(result.tool_use_id);
      if (!call) continue;
      call.result = result;
      call.resultIndex = i;
      call.chars += result.text.length;
    }
  });
  return calls;
}

// the transcript as the judge reads it: text kept, tool results replaced by a size note, fitted into a budget
export function buildState(messages: readonly Message[], calls: Call[], maxTokens: number, instructions?: string): { state: unknown; tokens: number } {
  const callIds = new Set(calls.map((c) => c.id));
  const render = (textCap: number, inputCap: number, from: number) => ({
    instructions: instructions ?? null,
    messages: messages.slice(from).map((m, j) => ({
      i: from + j,
      role: m.role,
      text: truncate(m.text, textCap),
      calls: m.toolUses.map((u) => ({
        id: u.tool_use_id,
        tool: u.tool,
        input: truncate(JSON.stringify(u.input), inputCap),
        judged: callIds.has(u.tool_use_id),
      })),
      results: (m.toolResults ?? []).map((r) => ({
        id: r.tool_use_id,
        note: `${r.isError ? 'error' : 'ok'}, ${r.text.length} chars`,
        head: truncate(r.text, Math.min(200, textCap)),
      })),
    })),
  });
  const stages: [number, number, number][] = [
    [4000, 600, 0],
    [1500, 300, 0],
    [600, 150, 0],
    [300, 80, 0],
  ];
  let state = render(...stages[0]!);
  let tokens = estimateTokensOf(state);
  for (const stage of stages) {
    state = render(...stage);
    tokens = estimateTokensOf(state);
    if (tokens <= maxTokens) return { state, tokens };
  }
  // still too big: drop the oldest unjudged messages until it fits, never the first
  let from = 1;
  while (tokens > maxTokens && from < messages.length - 1) {
    from += 1;
    state = render(300, 80, from);
    tokens = estimateTokensOf(state);
  }
  return { state, tokens };
}

export function questionsFor(calls: Call[]): Questions {
  const q: Questions = {};
  for (const c of calls) {
    q[`keep_${c.id}`] = {
      type: 'noul',
      instructions: `Call ${c.id} (${c.tool}) and its result are still needed for the work that remains in this conversation.`,
      criteria: 'A result that was superseded by a later call, fully acted on already, or unrelated to the current task is not needed.',
    };
    if (c.result && c.result.text.length > 0) {
      q[`full_${c.id}`] = {
        type: 'noul',
        instructions: `The full text of the result of call ${c.id} (${c.tool}) is still needed verbatim, not just the fact that it ran.`,
      };
    }
  }
  return q;
}

export function batchQuestions(questions: Questions, stateTokens: number, maxRequestTokens: number): Questions[] {
  const batches: Questions[] = [];
  let current: Questions = {};
  let tokens = stateTokens;
  for (const [id, q] of Object.entries(questions)) {
    const cost = estimateTokens(JSON.stringify(q)) + 8;
    if (tokens + cost > maxRequestTokens && Object.keys(current).length > 0) {
      batches.push(current);
      current = {};
      tokens = stateTokens;
    }
    current[id] = q;
    tokens += cost;
  }
  if (Object.keys(current).length > 0) batches.push(current);
  return batches;
}

export function applyDecisions(messages: readonly Message[], calls: Call[], decisions: CallDecision[], truncateHead: number): Message[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const callById = new Map(calls.map((c) => [c.id, c]));
  const out: Message[] = [];
  for (const m of messages) {
    const dropUses = m.toolUses.filter((u) => byId.get(u.tool_use_id)?.action === 'drop');
    const touchedResults = (m.toolResults ?? []).filter((r) => {
      const a = byId.get(r.tool_use_id)?.action;
      return a === 'drop' || a === 'truncate';
    });
    if (dropUses.length === 0 && touchedResults.length === 0) {
      out.push(m);
      continue;
    }
    const toolUses = m.toolUses.filter((u) => byId.get(u.tool_use_id)?.action !== 'drop');
    const toolResults = (m.toolResults ?? [])
      .filter((r) => byId.get(r.tool_use_id)?.action !== 'drop')
      .map((r) => {
        if (byId.get(r.tool_use_id)?.action !== 'truncate') return r;
        const call = callById.get(r.tool_use_id);
        const omitted = r.text.length - truncateHead;
        return {
          tool_use_id: r.tool_use_id,
          isError: r.isError,
          text: `${r.text.slice(0, truncateHead)}\n[sift: ${omitted} chars of this ${call?.tool ?? 'tool'} result omitted at compaction, rerun the call if needed]`,
        };
      });
    if (m.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) continue;
    const rebuilt: Message = { role: m.role, text: m.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    out.push(rebuilt);
  }
  return out;
}

export function decide(call: Call, keep: number, full: number, threshold: number): CallDecision {
  const action = keep < threshold ? 'drop' : full < threshold && call.result && call.result.text.length > 0 ? 'truncate' : 'keep';
  return { id: call.id, tool: call.tool, keep, full, action };
}

export async function compact(messages: readonly Message[], judge: Judge, options: CompactOptions): Promise<CompactResult> {
  const charsBefore = messages.reduce((n, m) => n + messageChars(m), 0);
  const pinnedFrom = Math.max(1, messages.length - options.pinRecent);
  const calls = collectCalls(messages, pinnedFrom);
  const base = { charsBefore, charsAfter: charsBefore, requests: 0, stateTokens: 0, decisions: [] as CallDecision[] };
  if (calls.length === 0) return { ...base, messages: [...messages] };
  const { state, tokens } = buildState(messages, calls, options.maxStateTokens, options.instructions);
  const batches = batchQuestions(questionsFor(calls), tokens, options.maxRequestTokens);
  const results = await Promise.all(batches.map((q) => judge.ask(state, q)));
  const answers: Record<string, number> = {};
  for (const r of results) {
    if (!r.ok) return { ...base, messages: [...messages], stateTokens: tokens, requests: batches.length, error: `${r.reason}: ${r.message}` };
    for (const [id, a] of Object.entries(r.answers)) if (a.type === 'noul') answers[id] = a.p;
  }
  const decisions = calls.map((c) => decide(c, answers[`keep_${c.id}`] ?? 1, answers[`full_${c.id}`] ?? 1, options.keepThreshold));
  const out = applyDecisions(messages, calls, decisions, options.truncateHead);
  return {
    messages: out,
    decisions,
    charsBefore,
    charsAfter: out.reduce((n, m) => n + messageChars(m), 0),
    requests: batches.length,
    stateTokens: tokens,
  };
}

export function reduction(result: CompactResult): number {
  return result.charsBefore === 0 ? 0 : 1 - result.charsAfter / result.charsBefore;
}

export { bandOf };
