import type { Judge } from '../judge/types.ts';
import { estimateTokensOf, truncate } from '../tokens.ts';
import { collectCalls, judgeCalls, messageChars, truncatedResult, type Call, type CallDecision, type CompactOptions, type CompactResult, type Message, type Verdict } from './compact.ts';

// how a ledger message opens; the marker finds it again at the next compaction
export const LEDGER_MARK = '[sift ledger]';
// how the engine's own summary opens when the built-in compaction ran
export const BUILTIN_SUMMARY_PREFIX = 'This session is being continued from a previous conversation';

export type LedgerCompactOptions = CompactOptions & {
  ledger: string;
  ledgerPath: string;
};

export type LedgerCompactResult = CompactResult & {
  summariesDropped: number;
  inFlight: boolean;
  tokensBefore: number;
  tokensAfter: number;
  // what the kept set costs outside the ledger and the pinned turns: the part that could grow
  residueTokens: number;
};

// a prior compaction's residue: the engine's summary or the ledger message an earlier round inserted
export function isSummary(m: Message): boolean {
  return m.role === 'user' && (m.toolResults ?? []).length === 0 && (m.text.startsWith(LEDGER_MARK) || m.text.startsWith(BUILTIN_SUMMARY_PREFIX));
}

export function ledgerMessage(ledger: string, path: string): Message {
  const body = ledger.trim().length > 0 ? ledger.trim() : '(empty)';
  return {
    role: 'user',
    text: `${LEDGER_MARK} ${path}, read at compaction. This is the live state; nothing before it was kept.\n\n${body}`,
    toolUses: [],
  };
}

// the last user prompt: the item the session is on, kept whole so the model knows what it was asked
export function lastPromptIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.text.trim().length > 0 && (m.toolResults ?? []).length === 0) return i;
  }
  return -1;
}

// how much of the ledger rides in the judge's goal beside the last prompt
const GOAL_LEDGER_CHARS = 4000;

const IN_FLIGHT_CONTEXT =
  'A long-lived agent keeps its durable state in a ledger file, shown here as `ledger`. Its conversation is being compacted. The question is whether the agent is in the middle of executing a step itself right now, so that the recent tool outputs in its conversation are the working set of that step and worth judging one by one, or whether everything it holds is finished, not started, or waiting on an outside event, so that the ledger alone is enough to continue from.';

// one question over the ledger alone: is the steward mid-step, or between items
export async function judgeInFlight(ledger: string, judge: Judge): Promise<{ inFlight: boolean; error?: string }> {
  if (ledger.trim().length === 0) return { inFlight: false };
  const r = await judge.ask(
    { context: IN_FLIGHT_CONTEXT, ledger },
    {
      in_flight: {
        type: 'noul',
        instructions: 'The ledger describes a step the agent is executing itself right now: a change being built or tested, an investigation under way, a review being addressed, work whose next action is the agent\'s own and not yet taken.',
        criteria: {
          true: 'At least one item is mid-step, with the agent as the next actor and the step not finished.',
          false: 'Every item is finished, unstarted, or waiting on an outside event (a CI run, an answer, a review, a tag, a message), or the ledger holds no items.',
        },
      },
    },
  );
  if (!r.ok) return { inFlight: true, error: `${r.reason}: ${r.message}` };
  const a = r.answers['in_flight'];
  return { inFlight: a?.type === 'noul' ? a.p >= 0.5 : true };
}

// keeps the pinned turns and the last prompt whole, keeps judged calls per their decision with their text dropped,
// and drops everything else; the ledger message goes first
export function applyLedgerPolicy(messages: readonly Message[], calls: Call[], decisions: CallDecision[], pinnedFrom: number, promptIndex: number, truncateHead: number): Message[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const callById = new Map(calls.map((c) => [c.id, c]));
  const out: Message[] = [];
  messages.forEach((m, i) => {
    if (i >= pinnedFrom || i === promptIndex) {
      out.push(m);
      return;
    }
    const toolUses = m.toolUses.filter((u) => byId.get(u.tool_use_id)?.action === 'keep' || byId.get(u.tool_use_id)?.action === 'truncate');
    const toolResults = (m.toolResults ?? [])
      .filter((r) => byId.get(r.tool_use_id)?.action === 'keep' || byId.get(r.tool_use_id)?.action === 'truncate')
      .map((r) => (byId.get(r.tool_use_id)?.action === 'truncate' ? truncatedResult(r, callById.get(r.tool_use_id)?.tool, truncateHead) : r));
    if (toolUses.length === 0 && toolResults.length === 0) return;
    const rebuilt: Message = { role: m.role, text: '', toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    out.push(rebuilt);
  });
  return out;
}

export async function compactWithLedger(messages: readonly Message[], judge: Judge, options: LedgerCompactOptions): Promise<LedgerCompactResult> {
  const charsBefore = messages.reduce((n, m) => n + messageChars(m), 0);
  const tokensBefore = estimateTokensOf(messages);
  const stripped = messages.filter((m) => !isSummary(m));
  const summariesDropped = messages.length - stripped.length;
  const pinnedFrom = Math.max(0, stripped.length - options.pinRecent);
  const promptIndex = lastPromptIndex(stripped);
  const ledger = ledgerMessage(options.ledger, options.ledgerPath);
  // the ledger, the pinned turns and the prompt are the bounded part; whatever else survives is residue
  const fixed = new Set(stripped.filter((_, i) => i >= pinnedFrom || i === promptIndex));
  const finish = (kept: Message[], inFlight: boolean, verdict: Verdict): LedgerCompactResult => {
    const out = [ledger, ...kept];
    const residue = kept.filter((m) => !fixed.has(m));
    return {
      messages: out,
      decisions: verdict.decisions,
      charsBefore,
      charsAfter: out.reduce((n, m) => n + messageChars(m), 0),
      requests: verdict.requests,
      stateTokens: verdict.stateTokens,
      stage: verdict.stage,
      summariesDropped,
      inFlight,
      tokensBefore,
      tokensAfter: estimateTokensOf(out),
      residueTokens: residue.length === 0 ? 0 : estimateTokensOf(residue),
    };
  };
  const flight = await judgeInFlight(options.ledger, judge);
  const asked: Verdict = { decisions: [], requests: flight.error === undefined && options.ledger.trim().length > 0 ? 1 : 0, stateTokens: 0 };
  if (!flight.inFlight) return finish(applyLedgerPolicy(stripped, [], [], pinnedFrom, promptIndex, options.truncateHead), false, asked);
  const calls = collectCalls(stripped, pinnedFrom, false);
  if (calls.length === 0) return finish(applyLedgerPolicy(stripped, [], [], pinnedFrom, promptIndex, options.truncateHead), true, asked);
  const goal = [stripped[promptIndex]?.text ?? '', truncate(options.ledger, GOAL_LEDGER_CHARS)].filter((t) => t.trim().length > 0).join('\n\n');
  const verdict = await judgeCalls(stripped, calls, judge, pinnedFrom, options, { goal, pinFirst: false });
  verdict.requests += asked.requests;
  if (verdict.error) {
    return {
      messages: [...messages],
      decisions: [],
      charsBefore,
      charsAfter: charsBefore,
      requests: verdict.requests,
      stateTokens: verdict.stateTokens,
      stage: verdict.stage,
      error: verdict.error,
      summariesDropped,
      inFlight: true,
      tokensBefore,
      tokensAfter: tokensBefore,
      residueTokens: 0,
    };
  }
  return finish(applyLedgerPolicy(stripped, calls, verdict.decisions, pinnedFrom, promptIndex, options.truncateHead), true, verdict);
}
