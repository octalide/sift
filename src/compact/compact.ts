import { bandOf } from '../judge/bands.ts';
import type { Judge, Questions } from '../judge/types.ts';
import { batchQuestions, estimateTokens, estimateTokensOf, JEV_LIMITS, truncate } from '../tokens.ts';

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
  keepThreshold: 0.35,
  pinRecent: 6,
  truncateHead: 300,
  maxStateTokens: Math.floor(JEV_LIMITS.stateTokens * 0.8),
  maxRequestTokens: Math.floor(JEV_LIMITS.requestTokens * 0.5),
};

export type Call = {
  id: string;
  // short id the judge sees, cheaper than the tool_use_id in every question
  label: string;
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
  // how far the state had to shrink to fit the judge
  stage?: string;
  error?: string;
};

export function messageChars(m: Message): number {
  return (
    m.text.length +
    m.toolUses.reduce((n, u) => n + JSON.stringify(u.input).length + (u.text?.length ?? 0), 0) +
    (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0)
  );
}

// the first message is the session's opening prompt and stays put unless the caller says otherwise
export function collectCalls(messages: readonly Message[], pinnedFrom: number, pinFirst = true): Call[] {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  messages.forEach((m, i) => {
    if ((pinFirst && i === 0) || i >= pinnedFrom) return;
    for (const use of m.toolUses) {
      const call: Call = { id: use.tool_use_id, label: `t${calls.length + 1}`, tool: use.tool, useIndex: i, use, chars: JSON.stringify(use.input).length };
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

const STATE_CONTEXT =
  'A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.';

const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

type Entry = { i: number; role: string; text: string; tool_calls?: ({ id: string; tool: string; input: string; result: string } | string)[] };

export type FittedState = { state: unknown; tokens: number; stage: string; fits: boolean };

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`;
}

function inputText(input: Record<string, unknown>, limit: number): string {
  let json = '';
  try {
    json = JSON.stringify(input);
  } catch {
    json = '[unserializable input]';
  }
  return truncate(json, limit);
}

function resultNote(c: Call): string {
  return c.result ? `${c.result.isError ? 'error' : 'ok'}, ${c.result.text.length} chars (omitted)` : 'no result';
}

// one call on a single line, for when the structured form is too costly; without its input as the last resort
function compactCall(c: Call, withInput = true): string {
  const input = Object.entries(c.use.input)
    .map(([k, v]) => `${k}=${(typeof v === 'string' ? v : inputText({ [k]: v }, 200)).replace(/\s+/g, ' ')}`)
    .join(' ');
  const outcome = `${c.result ? (c.result.isError ? 'error' : 'ok') : 'none'} ${c.result?.text.length ?? 0}ch`;
  return withInput ? `${c.label} ${c.tool} ${truncate(input, INPUT_CHARS[2])} → ${outcome}` : `${c.label} ${c.tool} → ${outcome}`;
}

// the last three user prompts, the goal the judge weighs every call against
export function goalOf(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === 'user' && m.text.trim().length > 0 && (m.toolResults ?? []).length === 0)
    .slice(-3)
    .map((m) => truncate(m.text, 500))
    .join('\n');
}

// the whole transcript as the judge reads it, shrunk in stages until it fits the budget: tool inputs truncated,
// long texts abridged oldest first, old messages collapsed to a note, old calls shrunk to one line, old call-less
// messages left out, runs of old call-only messages folded, old inputs dropped. every call stays visible at every stage
export type StateOptions = { instructions?: string; goal?: string; pinFirst?: boolean };

export function buildState(messages: readonly Message[], calls: Call[], maxTokens: number, pinnedFrom: number, options: StateOptions = {}): FittedState {
  const goal = options.goal ?? goalOf(messages);
  const stateOf = (history: Entry[]) => ({ context: STATE_CONTEXT, instructions: options.instructions ?? null, goal, history });
  const entryTokens = (e: Entry) => estimateTokensOf(e) + 1;
  const baseTokens = estimateTokensOf(stateOf([]));
  const pinFirst = options.pinFirst ?? true;
  const pinned = (e: Entry) => (pinFirst && e.i === 0) || e.i >= pinnedFrom;
  const byMessage = new Map<number, Call[]>();
  for (const c of calls) byMessage.set(c.useIndex, [...(byMessage.get(c.useIndex) ?? []), c]);

  let history: Entry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const done = (stage: string): FittedState => ({ state: stateOf(history), tokens, stage, fits: tokens <= maxTokens });
  const fits = () => tokens <= maxTokens;
  const rebuild = (inputChars: number) => {
    history = [];
    messages.forEach((m, i) => {
      const own = (byMessage.get(i) ?? []).map((c) => ({ id: c.label, tool: c.tool, input: inputText(c.use.input, inputChars), result: resultNote(c) }));
      if (m.text.trim().length === 0 && own.length === 0) return;
      const e: Entry = { i, role: m.role, text: m.text };
      if (own.length > 0) e.tool_calls = own;
      history.push(e);
    });
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((a, b) => a + b, 0);
  };
  const shrink = (index: number, change: (e: Entry) => void) => {
    const e = history[index]!;
    change(e);
    const now = entryTokens(e);
    tokens += now - perEntry[index]!;
    perEntry[index] = now;
  };

  rebuild(INPUT_CHARS[0]);
  if (fits()) return done('full');
  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return done(`inputs<=${limit}`);
  }

  const indices = history.map((_, i) => i);
  const order = [...indices.filter((i) => !pinned(history[i]!)), ...indices.filter((i) => pinned(history[i]!))];

  for (const i of order) {
    if (history[i]!.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(i, (e) => (e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL)));
    if (fits()) return done('texts abridged');
  }
  for (const i of order) {
    const e = history[i]!;
    if (pinned(e) || e.text.length === 0) continue;
    const original = messages[e.i]!.text.length;
    shrink(i, (x) => (x.text = `[… ${original} chars omitted …]`));
    if (fits()) return done('old messages collapsed');
  }
  for (const i of order) {
    const e = history[i]!;
    const own = byMessage.get(e.i);
    if (pinned(e) || !own) continue;
    shrink(i, (x) => (x.tool_calls = own.map((c) => compactCall(c))));
    if (fits()) return done('old calls compacted');
  }
  const left = new Set<number>();
  for (const i of order) {
    const e = history[i]!;
    if (pinned(e) || e.tool_calls) continue;
    left.add(i);
    tokens -= perEntry[i]!;
    if (fits()) {
      history = history.filter((_, j) => !left.has(j));
      return done('old messages left out');
    }
  }
  const merged: Entry[] = [];
  const foldable = (e: Entry) => !pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === 'string';
  for (const e of history.filter((_, j) => !left.has(j))) {
    const prev = merged[merged.length - 1];
    if (prev && foldable(prev) && foldable(e) && prev.role === e.role) {
      prev.tool_calls = [...(prev.tool_calls as string[]), ...(e.tool_calls as string[])];
      continue;
    }
    merged.push({ ...e });
  }
  history = merged;
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((a, b) => a + b, 0);
  if (fits()) return done('old calls merged');

  const labels = new Map(calls.map((c) => [c.label, c]));
  history.forEach((e, i) => {
    if (pinned(e) || typeof e.tool_calls?.[0] !== 'string') return;
    shrink(i, (x) => (x.tool_calls = (x.tool_calls as string[]).map((line) => compactCall(labels.get(line.split(' ')[0]!)!, false))));
  });
  return done('old inputs dropped');
}

export function questionsFor(calls: Call[]): Questions {
  const q: Questions = {};
  for (const c of calls) {
    q[`keep_${c.label}`] = {
      type: 'noul',
      instructions: `Tool call ${c.label} (${c.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next.`,
      criteria: {
        true: 'The call or its input informs work that has not happened yet.',
        false: 'The call was superseded by a later call, fully acted on already, or is unrelated to the goal.',
      },
    };
    if (c.result && c.result.text.length > 0) {
      q[`full_${c.label}`] = {
        type: 'noul',
        instructions: `The full output of tool call ${c.label} (${c.tool}, ${c.result.text.length} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do.`,
      };
    }
  }
  return q;
}

export function truncatedResult(r: ToolResult, tool: string | undefined, truncateHead: number): ToolResult {
  const omitted = r.text.length - truncateHead;
  return {
    tool_use_id: r.tool_use_id,
    isError: r.isError,
    text: `${r.text.slice(0, truncateHead)}\n[sift: ${omitted} chars of this ${tool ?? 'tool'} result omitted at compaction, rerun the call if needed]`,
  };
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
      .map((r) => (byId.get(r.tool_use_id)?.action === 'truncate' ? truncatedResult(r, callById.get(r.tool_use_id)?.tool, truncateHead) : r));
    if (m.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) continue;
    const rebuilt: Message = { role: m.role, text: m.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    out.push(rebuilt);
  }
  return out;
}

// a needed result keeps its call whatever the call scored; a needed call keeps a truncated result; else both go
export function decide(call: Call, keep: number, full: number, threshold: number): CallDecision {
  const hasResult = !!call.result && call.result.text.length > 0;
  const action = hasResult && full >= threshold ? 'keep' : keep >= threshold ? (hasResult ? 'truncate' : 'keep') : 'drop';
  return { id: call.id, tool: call.tool, keep, full, action };
}

const TOO_LARGE = new Set([400, 413]);

export type Verdict = { requests: number; stateTokens: number; stage?: string; decisions: CallDecision[]; error?: string };

// asks the judge about every collected call, shrinking the state to fit and retrying once on a size rejection
export async function judgeCalls(messages: readonly Message[], calls: Call[], judge: Judge, pinnedFrom: number, options: CompactOptions, state: StateOptions = {}): Promise<Verdict> {
  const questions = questionsFor(calls);
  const ask = async (budget: number) => {
    const fitted = buildState(messages, calls, budget, pinnedFrom, { instructions: options.instructions, ...state });
    if (!fitted.fits) return { ...fitted, batches: [] as Questions[], results: [] as Awaited<ReturnType<Judge['ask']>>[] };
    const batches = batchQuestions(questions, fitted.tokens, options.maxRequestTokens);
    return { ...fitted, batches, results: await Promise.all(batches.map((q) => judge.ask(fitted.state, q))) };
  };
  let attempt = await ask(options.maxStateTokens);
  // the estimate only approximates the server's tokenizer; a size rejection is its verdict, so shrink once and retry
  if (attempt.results.some((r) => !r.ok && r.status !== undefined && TOO_LARGE.has(r.status))) {
    attempt = await ask(Math.floor(options.maxStateTokens / 2));
  }
  const { tokens, batches, results, stage } = attempt;
  const base = { requests: batches.length, stateTokens: tokens, stage, decisions: [] as CallDecision[] };
  if (!attempt.fits) return { ...base, error: `history too large for the judge (~${tokens} tokens after ${stage}, limit ${options.maxStateTokens})` };
  const answers: Record<string, number> = {};
  for (const r of results) {
    if (!r.ok) return { ...base, error: `${r.reason}: ${r.message}` };
    for (const [id, a] of Object.entries(r.answers)) if (a.type === 'noul') answers[id] = a.p;
  }
  return { ...base, decisions: calls.map((c) => decide(c, answers[`keep_${c.label}`] ?? 1, answers[`full_${c.label}`] ?? 1, options.keepThreshold)) };
}

export async function compact(messages: readonly Message[], judge: Judge, options: CompactOptions): Promise<CompactResult> {
  const charsBefore = messages.reduce((n, m) => n + messageChars(m), 0);
  const pinnedFrom = Math.max(1, messages.length - options.pinRecent);
  const calls = collectCalls(messages, pinnedFrom);
  const base = { charsBefore, charsAfter: charsBefore, requests: 0, stateTokens: 0, decisions: [] as CallDecision[] };
  if (calls.length === 0) return { ...base, messages: [...messages] };
  const verdict = await judgeCalls(messages, calls, judge, pinnedFrom, options);
  if (verdict.error) return { ...base, messages: [...messages], stateTokens: verdict.stateTokens, requests: verdict.requests, error: verdict.error };
  const out = applyDecisions(messages, calls, verdict.decisions, options.truncateHead);
  return {
    messages: out,
    decisions: verdict.decisions,
    charsBefore,
    charsAfter: out.reduce((n, m) => n + messageChars(m), 0),
    requests: verdict.requests,
    stateTokens: verdict.stateTokens,
    stage: verdict.stage,
  };
}

export function reduction(result: CompactResult): number {
  return result.charsBefore === 0 ? 0 : 1 - result.charsAfter / result.charsBefore;
}

export { bandOf };
