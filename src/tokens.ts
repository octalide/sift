// jev's documented limits: 64k tokens per request, 32k for the state plus the longest question
export const JEV_LIMITS = { stateTokens: 32_000, requestTokens: 64_000 };

const PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

// tokens without a tokenizer: a word costs one per six letters, a digit half, any other symbol nine tenths.
// calibrated against jev's reported usage on real transcripts (fast-jev-compaction, MIT), where it lands
// a little above the true count; a flat chars-per-token ratio undercounts json-heavy states by up to 40%
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) tokens += 1 + Math.floor((piece.length - 1) / 6);
    else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

export function estimateTokensOf(value: unknown): number {
  return estimateTokens(typeof value === 'string' ? value : JSON.stringify(value) ?? '');
}

export function truncate(text: string, maxChars: number, note = '…'): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}${note}`;
}
