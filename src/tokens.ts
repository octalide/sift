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

// the longest prefix of text that costs at most tokens as a json string in the state, never splitting a surrogate pair
export function prefixWithin(text: string, tokens: number): string {
  const cost = (n: number) => estimateTokens(JSON.stringify(text.slice(0, n)));
  if (cost(text.length) <= tokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cost(mid) <= tokens) lo = mid;
    else hi = mid - 1;
  }
  const end = text.charCodeAt(lo - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? lo - 1 : lo);
}

export function truncate(text: string, maxChars: number, note = '…'): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}${note}`;
}

// splits questions into requests that stay under the budget with the state repeated in each
export function batchQuestions<Q>(questions: Record<string, Q>, stateTokens: number, maxRequestTokens: number): Record<string, Q>[] {
  const batches: Record<string, Q>[] = [];
  let current: Record<string, Q> = {};
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
