// the noun this plugin adds to `$`, for its own modules and for other plugins that depend on it
export type SiftQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type SiftAnswer =
  | { type: 'noul'; p: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: string; probabilities: number[]; confidence: number };

export type SiftJudgement =
  | { ok: true; answers: Record<string, SiftAnswer>; backend: string; latencyMs: number }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'rejected' | 'malformed'; message: string; backend: string };

export type SiftRankMode = 'batched' | 'isolated';

export type SiftRankOptions = {
  mode: SiftRankMode;
  // state every item is read against, placed beside the items
  context?: Record<string, unknown>;
  // the question the sorted view orders by, the first when absent; for a choice question, the key whose probability orders it
  by?: string;
  choice?: string;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  concurrency?: number;
  // the item fields the state carries beside k, every field when absent; every field still fills the questions
  fields?: string[];
};

export type SiftRanked<T> = { index: number; item: T; answers: Record<string, SiftAnswer>; value: number };

export type SiftRankResult<T> =
  | { ok: true; items: SiftRanked<T>[]; sorted: SiftRanked<T>[]; requests: number; backend: string }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'rejected' | 'malformed'; message: string; backend: string; requests: number };

export type SiftJudged = { id: string; answer: SiftAnswer; band: 'satisfied' | 'violated' | 'unclear'; severity: 'fail' | 'warn' | 'info'; instructions: string };

export type SiftReport = {
  pack: string;
  subject: string;
  mechanical: { check: string; severity: 'fail' | 'warn' | 'info'; message: string }[];
  judged: SiftJudged[];
  // one entry per rank step of the pack, its items in order (each) or the best by value (top)
  ranked: { step: string; list: 'each' | 'top'; total: number; kept: number; items: (SiftJudged & { index: number; label: string; answers: Record<string, SiftAnswer> })[] }[];
  verdict: 'pass' | 'warn' | 'fail' | 'unknown';
  backend: string;
  judgeError?: string;
};

export type Sift = {
  // typed questions over any state, answered by the configured backend
  judge: (state: unknown, questions: Record<string, SiftQuestion>) => Promise<SiftJudgement>;
  // the same questions over many items: batched fills each request with items, isolated sends one request per item.
  // {k} in a question is the item index, {field} a field of an object item, {text} a string item
  rank: <T extends string | Record<string, unknown>>(items: T[], questions: Record<string, SiftQuestion>, options: SiftRankOptions) => Promise<SiftRankResult<T>>;
  // run a pack over a subject: an issue or PR number, a commit range, "release", a job or run id, or text; top cuts a ranked list
  grade: (pack: string, subject: string, options?: { repo?: string; text?: string; ref?: string; top?: number }) => Promise<SiftReport>;
  // the backend name in use
  backend: () => string;
};

declare module 'claude-code' {
  interface EngineInterface {
    sift: Sift;
  }
}
