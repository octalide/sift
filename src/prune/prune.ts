import { rank } from '../judge/rank.ts';
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

// one question per chunk, the chunk named by its index and line range in the state
const NEEDED: Questions = {
  needed: {
    type: 'noul',
    instructions: 'At least one line in chunk {k} (lines {lines}) is needed to carry out the task or answer the user.',
    criteria: {
      true: 'The chunk holds a result, diagnostic, or value the task asks about.',
      false: 'The chunk is progress output, repeated boilerplate, or a listing the task does not refer to.',
    },
  },
};

// the one-line stub left where a run of chunks was dropped: the range and the call that gets it back
export type OmissionNote = (from: number, to: number) => string;

export function omissionNote(context: PruneContext): OmissionNote {
  const stub = (from: number, to: number, recover: string) => `[sift: lines ${from}-${to} (${to - from + 1} lines) omitted as not needed for the current task, ${recover}]`;
  if (context.tool === 'Read') {
    // output lines map to file lines through the call's offset, so the note is in file lines
    const base = Math.max(1, Number(context.input['offset']) || 1);
    const path = String(context.input['file_path'] ?? 'the file');
    return (from, to) => stub(base + from - 1, base + to - 1, `re-read ${path} with offset ${base + from - 1} limit ${to - from + 1}`);
  }
  if (context.tool === 'Bash') return (from, to) => stub(from, to, 'rerun the command for the full output');
  return (from, to) => stub(from, to, 'rerun the tool call for the full output');
}

export function assemble(chunks: Chunk[], keep: (c: Chunk) => boolean, note: OmissionNote): string {
  const parts: string[] = [];
  let omitted: Chunk[] = [];
  const flush = () => {
    if (omitted.length === 0) return;
    parts.push(note(omitted[0]!.from, omitted[omitted.length - 1]!.to));
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
  // every chunk rides in the state so the judge reads the whole output, protected ones are asked about and ignored
  const ranked = await rank(
    chunks.map((c) => ({ lines: `${c.from}-${c.to}`, text: c.text })),
    NEEDED,
    judge,
    { mode: 'batched', context: { tool: context.tool, input: context.input, task: truncate(context.task, 2000) }, maxRequestTokens: options.maxRequestTokens },
  );
  if (!ranked.ok) return { ...none('judge failed'), skipped: undefined, error: `${ranked.reason}: ${ranked.message}` };
  const scores: Record<number, number> = {};
  for (const r of ranked.items) if (!chunks[r.index]!.protected) scores[r.index] = r.value;
  const keep = (c: Chunk) => c.protected || (scores[c.k] ?? 1) >= options.keepThreshold;
  const kept = chunks.filter(keep).length;
  return {
    text: assemble(chunks, keep, omissionNote(context)),
    chunks: chunks.length,
    kept,
    dropped: chunks.length - kept,
    scores,
    requests: ranked.requests,
  };
}
