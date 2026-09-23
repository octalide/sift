// the noun this plugin adds to `$`, for its own modules and for other plugins that depend on it
export type SiftQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type SiftAnswer =
  | { type: 'noul'; p: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  // score is the most likely level index, expected the probability-weighted position between levels
  | { type: 'score'; score: number; expected: number; legend: string; probabilities: number[]; confidence: number };

export type SiftFailure = 'disabled' | 'unavailable' | 'rejected' | 'malformed';

// what a call cost: the backend's own count when it reports one, else an estimate from the bytes sent and received
export type SiftUsage = { requestTokens: number; responseTokens: number; source: 'backend' | 'estimate' };

// a key named without its value: where it came from and its last four characters
export type SiftKeyRef = { source: 'option' | 'env' | 'settings'; ending: string };

// the key in use, and every other source that holds a key, marked when that key is the same one
export type SiftKeyOrigin = SiftKeyRef & { others: (SiftKeyRef & { same: boolean })[] };

export type SiftJudgement =
  | { ok: true; answers: Record<string, SiftAnswer>; backend: string; latencyMs: number; usage?: SiftUsage }
  // status is the backend's http status, key is set only when the backend rejected the key
  | { ok: false; reason: SiftFailure; message: string; backend: string; status?: number; key?: SiftKeyOrigin; usage?: SiftUsage };

export type SiftRankMode = 'batched' | 'isolated';

export type SiftRankOptions = {
  mode: SiftRankMode;
  // state every item is read against, placed beside the items
  context?: Record<string, unknown>;
  // the question the sorted view orders by, the first when absent
  by?: string;
  // for a choice question: the key whose probability orders the view, the chosen key's confidence when absent
  choice?: string;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  // requests in flight at once
  concurrency?: number;
  // the item fields the state carries beside k, every field when absent; every field still fills the questions
  fields?: string[];
};

export type SiftRanked<T> = { index: number; item: T; answers: Record<string, SiftAnswer>; value: number };

export type SiftRankResult<T> =
  // dropped: answers under a key no item or question of the request owns
  | { ok: true; items: SiftRanked<T>[]; sorted: SiftRanked<T>[]; requests: number; dropped: number; backend: string; usage?: SiftUsage }
  | { ok: false; reason: SiftFailure; message: string; backend: string; requests: number; key?: SiftKeyOrigin };

// answer is absent when the judge left the question unanswered, the band is then unclear
export type SiftJudged = { id: string; answer?: SiftAnswer; band: 'satisfied' | 'violated' | 'unclear'; severity: 'fail' | 'warn' | 'info'; instructions: string };

export type SiftReport = {
  pack: string;
  subject: string;
  mechanical: { check: string; severity: 'fail' | 'warn' | 'info'; message: string }[];
  judged: SiftJudged[];
  // one entry per rank step of the pack, its items in order (each), the best by value (top), or those ruled out (violated);
  // an item is judged on the step's ordering question, asked holds every question of the step judged for it
  ranked: { step: string; list: 'each' | 'top' | 'violated'; total: number; kept: number; items: (SiftJudged & { index: number; label: string; answers: Record<string, SiftAnswer>; asked: SiftJudged[] })[] }[];
  verdict: 'pass' | 'warn' | 'fail' | 'unknown';
  backend: string;
  judgeError?: string;
  // answers under an id no question asked for, and answers the judge left out of a ranked item, dropped without touching the verdict
  dropped?: number;
};

export type SiftGradeOptions = {
  // owner/name, the checkout's repository when absent
  repo?: string;
  // the directory whose checkout the grade reads, absolute; the calling agent's or the session's when absent
  cwd?: string;
  // free text subject for rules, locate and text packs, or the plan for plan
  text?: string;
  // release: the branch or sha the release is cut from
  ref?: string;
  // how many items every top list shows, over each rank step's own setting
  top?: number;
};

export type Sift = {
  // typed questions over any state, answered by the configured backend
  judge: (state: unknown, questions: Record<string, SiftQuestion>) => Promise<SiftJudgement>;
  // the same questions over many items: batched fills each request with items, isolated sends one request per item.
  // {k} in a question is the item index, {field} a field of an object item, {text} a string item
  rank: <T extends string | Record<string, unknown>>(items: T[], questions: Record<string, SiftQuestion>, options: SiftRankOptions) => Promise<SiftRankResult<T>>;
  // run a pack over a subject: an issue or PR number or url, a commit ref or range, "release" or a version, or text
  grade: (pack: string, subject: string, options?: SiftGradeOptions) => Promise<SiftReport>;
  // the backend name in use
  backend: () => string;
};

declare module 'claude-code' {
  interface EngineInterface {
    sift: Sift;
  }
}
