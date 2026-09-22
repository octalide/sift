import type { Decision } from '../judge/index.ts';
import type { Judge } from '../judge/types.ts';
import { estimateTokens } from '../tokens.ts';
import type { PruneCall, PruneLoops } from './loops.ts';
import { prune, type PruneOptions } from './prune.ts';

export type PruneCallOptions = PruneOptions & { tools: readonly string[]; shadow: boolean };

// where the step reports what it decided
export type PruneSink = {
  record: (action: string, extra: Partial<Decision>) => void;
  toast: (text: string) => void;
};

// what a tool call resolved to, as far as prune reads it
export type CallResult = { result?: unknown; deny?: string; isError?: boolean };

// the output text prune reads from a tool's result: Bash stdout, Read file content
function outputOf(tool: string, result: unknown): string | undefined {
  if (tool === 'Bash') return (result as { stdout?: string } | undefined)?.stdout;
  if (tool === 'Read') return (result as { file?: { content?: string } } | undefined)?.file?.content;
  return undefined;
}

function withOutput(tool: string, result: unknown, text: string): { result: Record<string, unknown> } {
  if (tool === 'Bash') return { result: { ...(result as Record<string, unknown>), stdout: text } };
  const read = result as { file: Record<string, unknown> } & Record<string, unknown>;
  return { result: { ...read, file: { ...read.file, content: text } } };
}

// the post-call prune step: the floor, then the loop's back-offs with no judge call, then the judge
export async function pruneCall<R extends CallResult>(call: PruneCall, r: R, loops: PruneLoops, judge: Judge, options: PruneCallOptions, sink: PruneSink): Promise<R | { result: Record<string, unknown> }> {
  if (!options.tools.includes(call.tool) || r.deny !== undefined || r.isError) return r;
  const text = outputOf(call.tool, r.result);
  if (typeof text !== 'string' || estimateTokens(text) < options.floorTokens) return r;
  const backoff = loops.backoff(call);
  if (backoff !== undefined) {
    sink.record('none', { digest: `${call.tool}: ${backoff}` });
    return r;
  }
  const pruned = await prune(text, { tool: call.tool, input: call.input, task: loops.task(call.agentId) ?? '' }, judge, options);
  if (pruned.error) {
    sink.record('fallback', { ok: false, reason: pruned.error, digest: call.tool });
    return r;
  }
  if (pruned.skipped || pruned.dropped === 0) {
    sink.record('none', { digest: `${call.tool}: ${pruned.skipped ?? 'nothing dropped'}` });
    return r;
  }
  const before = estimateTokens(text);
  const after = estimateTokens(pruned.text);
  sink.record(options.shadow ? 'would-prune' : 'pruned', { digest: `${call.tool}: ${pruned.dropped}/${pruned.chunks} chunks, ~${before - after} tokens`, tokensRemoved: before - after, answers: Object.fromEntries(Object.entries(pruned.scores).map(([k, v]) => [k, v.toFixed(2)])) });
  sink.toast(`sift${options.shadow ? ' (shadow)' : ''}: ${call.tool} output ${pruned.dropped}/${pruned.chunks} chunks dropped, ~${before - after} tokens`);
  if (options.shadow) return r;
  loops.pruned(call);
  return withOutput(call.tool, r.result, pruned.text);
}
