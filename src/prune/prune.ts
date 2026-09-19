import type { Judge, Questions } from '../judge/types.ts';
import { estimateTokens, JEV_LIMITS, truncate } from '../tokens.ts';

export type PruneOptions = {
  floorTokens: number;
  chunkLines: number;
  keepThreshold: number;
  maxRequestTokens: number;
  maxChunks: number;
};

export const PRUNE_DEFAULTS: PruneOptions = {
  floorTokens: 4000,
  chunkLines: 25,
  keepThreshold: 0.5,
  maxRequestTokens: Math.floor(JEV_LIMITS.requestTokens * 0.5),
  maxChunks: 160,
};

export type Chunk = { k: number; from: number; to: number; text: string; protected: boolean };

export type PruneContext = {
  tool: string;
  input: Record<string, unknown>;
  // the newest user text, what the model is working on
  task: string;
  archivePath?: string;
};

export type PruneResult = {
  text: string;
  chunks: number;
  kept: number;
  dropped: number;
  scores: Record<number, number>;
  requests: number;
  skipped?: string;
  error?: string;
};

const DIAGNOSTIC = /\b(error|errors|warning|warn|fail|failed|failure|exception|traceback|panic|fatal|denied|not found|cannot|unexpected|assert)\b|✗|✘|FAIL|Error:/i;
const MAX_LINE = 2000;

export function chunkText(text: string, chunkLines: number, maxChunks: number): Chunk[] {
  const lines = text.split('\n').flatMap((l) => (l.length > MAX_LINE ? l.match(new RegExp(`.{1,${MAX_LINE}}`, 'g')) ?? [l] : [l]));
  let per = chunkLines;
  if (Math.ceil(lines.length / per) > maxChunks) per = Math.ceil(lines.length / maxChunks);
  const chunks: Chunk[] = [];
  for (let i = 0; i < lines.length; i += per) {
    const slice = lines.slice(i, i + per);
    const body = slice.join('\n');
    chunks.push({ k: chunks.length, from: i + 1, to: i + slice.length, text: body, protected: DIAGNOSTIC.test(body) });
  }
  if (chunks.length > 0) {
    chunks[0]!.protected = true;
    chunks[chunks.length - 1]!.protected = true;
  }
  return chunks;
}

function questionsFor(chunks: Chunk[]): Questions {
  const q: Questions = {};
  for (const c of chunks) {
    if (c.protected) continue;
    q[`c${c.k}`] = {
      type: 'noul',
      instructions: `At least one line in chunk ${c.k} (lines ${c.from}-${c.to}) is needed to carry out the task or answer the user.`,
      criteria: {
        true: 'The chunk holds a result, diagnostic, or value the task asks about.',
        false: 'The chunk is progress output, repeated boilerplate, or a listing the task does not refer to.',
      },
    };
  }
  return q;
}

// splits the chunks into requests whose state stays under the budget
function batches(chunks: Chunk[], context: PruneContext, maxRequestTokens: number): Chunk[][] {
  const overhead = estimateTokens(JSON.stringify({ tool: context.tool, input: context.input, task: truncate(context.task, 2000) })) + 200;
  const out: Chunk[][] = [];
  let current: Chunk[] = [];
  let tokens = overhead;
  for (const c of chunks) {
    const cost = estimateTokens(c.text) + 60;
    if (tokens + cost > maxRequestTokens && current.length > 0) {
      out.push(current);
      current = [];
      tokens = overhead;
    }
    current.push(c);
    tokens += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function assemble(chunks: Chunk[], keep: (c: Chunk) => boolean, archivePath?: string): string {
  const parts: string[] = [];
  let omitted: Chunk[] = [];
  const flush = () => {
    if (omitted.length === 0) return;
    const from = omitted[0]!.from;
    const to = omitted[omitted.length - 1]!.to;
    const where = archivePath ? `, full output at ${archivePath}` : '';
    parts.push(`[sift: lines ${from}-${to} (${to - from + 1} lines) omitted as not needed for the current task${where}]`);
    omitted = [];
  };
  for (const c of chunks) {
    if (keep(c)) {
      flush();
      parts.push(c.text);
    } else {
      omitted.push(c);
    }
  }
  flush();
  return parts.join('\n');
}

export async function prune(text: string, context: PruneContext, judge: Judge, options: PruneOptions): Promise<PruneResult> {
  const none = (skipped: string): PruneResult => ({ text, chunks: 0, kept: 0, dropped: 0, scores: {}, requests: 0, skipped });
  if (estimateTokens(text) < options.floorTokens) return none('under floor');
  const chunks = chunkText(text, options.chunkLines, options.maxChunks);
  const judged = chunks.filter((c) => !c.protected);
  if (judged.length === 0) return none('every chunk protected');
  const scores: Record<number, number> = {};
  const groups = batches(chunks, context, options.maxRequestTokens);
  const results = await Promise.all(
    groups.map((group) =>
      judge.ask(
        {
          tool: context.tool,
          input: context.input,
          task: truncate(context.task, 2000),
          note: groups.length > 1 ? `part of a larger output, chunks ${group[0]!.k}-${group[group.length - 1]!.k}` : undefined,
          chunks: group.map((c) => ({ k: c.k, lines: `${c.from}-${c.to}`, text: c.text })),
        },
        questionsFor(group),
      ),
    ),
  );
  for (const r of results) {
    if (!r.ok) return { ...none('judge failed'), skipped: undefined, error: `${r.reason}: ${r.message}` };
    for (const [id, a] of Object.entries(r.answers)) if (a.type === 'noul') scores[Number(id.slice(1))] = a.p;
  }
  const keep = (c: Chunk) => c.protected || (scores[c.k] ?? 1) >= options.keepThreshold;
  const kept = chunks.filter(keep).length;
  return {
    text: assemble(chunks, keep, context.archivePath),
    chunks: chunks.length,
    kept,
    dropped: chunks.length - kept,
    scores,
    requests: groups.length,
  };
}
