import { rank } from '../judge/rank.ts';
import { failureText, type Judge, type Questions } from '../judge/types.ts';
import { estimateTokens, JEV_LIMITS, truncate } from '../tokens.ts';
import { PRUNE_TOOL } from './loops.ts';

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

// from and to are source line numbers, continues marks a chunk that starts partway through a split line
export type Chunk = { k: number; from: number; to: number; text: string; protected: boolean; continues: boolean };

export type PruneContext = {
  tool: string;
  input: Record<string, unknown>;
  // the calling loop's task: a subagent's spawn prompt, or the main loop's newest prompt from a person
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

// tools whose output may lose lines only at its end: the engine numbers a Read's content from its one startLine
// and has no way to show a gap, so an omission in front of kept lines would misnumber every line after it
const TAIL_ONLY = new Set(['Read']);

const DIAGNOSTIC = /\b(error|errors|warning|warn|fail|failed|failure|exception|traceback|panic|fatal|denied|not found|cannot|unexpected|assert)\b|✗|✘|FAIL|Error:/i;
const MAX_LINE = 2000;

// a line over MAX_LINE is split into pieces so no single line can swamp a judge request, each piece keeps its source line
type Piece = { line: number; text: string; first: boolean };

function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  text.split('\n').forEach((l, i) => {
    const parts = l.length > MAX_LINE ? (l.match(new RegExp(`.{1,${MAX_LINE}}`, 'g')) ?? [l]) : [l];
    parts.forEach((p, j) => out.push({ line: i + 1, text: p, first: j === 0 }));
  });
  return out;
}

export function chunkText(text: string, chunkLines: number, maxChunks: number, protectLast = true): Chunk[] {
  const all = pieces(text);
  let per = chunkLines;
  if (Math.ceil(all.length / per) > maxChunks) per = Math.ceil(all.length / maxChunks);
  const chunks: Chunk[] = [];
  for (let i = 0; i < all.length; i += per) {
    const slice = all.slice(i, i + per);
    // pieces of one source line rejoin with no separator, a new source line starts on a new line
    const body = slice.map((p, j) => (j > 0 && p.first ? '\n' : '') + p.text).join('');
    chunks.push({ k: chunks.length, from: slice[0]!.line, to: slice[slice.length - 1]!.line, text: body, protected: DIAGNOSTIC.test(body), continues: !slice[0]!.first });
  }
  if (chunks.length > 0) {
    chunks[0]!.protected = true;
    if (protectLast) chunks[chunks.length - 1]!.protected = true;
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

// the one-line stub left where a run of chunks was dropped: the range, the call that gets it back, and the opt-out
export type OmissionNote = (from: number, to: number) => string;

export function omissionNote(context: PruneContext): OmissionNote {
  const stub = (from: number, to: number, recover: string) => `[sift: lines ${from}-${to} (${to - from + 1} lines) omitted as not needed for the current task, ${recover}]`;
  if (context.tool === 'Read') {
    // output lines map to file lines through the call's offset, so the note is in file lines
    const base = Math.max(1, Number(context.input['offset']) || 1);
    const path = String(context.input['file_path'] ?? 'the file');
    return (from, to) => stub(base + from - 1, base + to - 1, `re-read ${path} with offset ${base + from - 1} limit ${to - from + 1}, or call ${PRUNE_TOOL} off to read files whole`);
  }
  if (context.tool === 'Bash') return (from, to) => stub(from, to, 'rerun the command for the full output, or end a command with # sift: full to keep its output whole');
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
      // a chunk that continues a split line rejoins its kept predecessor without a newline
      if (c.continues && omitted.length === 0 && parts.length > 0) parts[parts.length - 1] += c.text;
      else {
        flush();
        parts.push(c.text);
      }
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
  const tailOnly = TAIL_ONLY.has(context.tool);
  const chunks = chunkText(text, options.chunkLines, options.maxChunks, !tailOnly);
  const judged = chunks.filter((c) => !c.protected);
  if (judged.length === 0) return none('every chunk protected');
  // every chunk rides in the state so the judge reads the whole output, protected ones are asked about and ignored
  const ranked = await rank(
    chunks.map((c) => ({ lines: `${c.from}-${c.to}`, text: c.text })),
    NEEDED,
    judge,
    { mode: 'batched', context: { tool: context.tool, input: context.input, task: truncate(context.task, 2000) }, maxRequestTokens: options.maxRequestTokens },
  );
  if (!ranked.ok) return { ...none('judge failed'), skipped: undefined, error: failureText(ranked) };
  const scores: Record<number, number> = {};
  for (const r of ranked.items) if (!chunks[r.index]!.protected) scores[r.index] = r.value;
  const needed = (c: Chunk) => c.protected || (scores[c.k] ?? 1) >= options.keepThreshold;
  // a tail-only tool keeps everything up to its last needed chunk and omits only what follows it
  const last = chunks.findLastIndex(needed);
  const keep = tailOnly ? (c: Chunk) => c.k <= last : needed;
  if (tailOnly && last === chunks.length - 1 && chunks.some((c) => !needed(c))) return { ...none('gap would misnumber lines'), chunks: chunks.length, kept: chunks.length, scores, requests: ranked.requests };
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
