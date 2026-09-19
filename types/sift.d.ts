// the noun this plugin adds to `$`, for its own modules and for other plugins that depend on it
export type SiftQuestion =
  | { type: 'noul'; instructions: string; criteria?: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type SiftAnswer =
  | { type: 'noul'; p: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: string; probabilities: number[]; confidence: number };

export type SiftJudgement =
  | { ok: true; answers: Record<string, SiftAnswer>; backend: string; latencyMs: number }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'rejected' | 'malformed'; message: string; backend: string };

export type SiftReport = {
  pack: string;
  subject: string;
  mechanical: { check: string; severity: 'fail' | 'warn' | 'info'; message: string }[];
  judged: { id: string; answer: SiftAnswer; band: 'satisfied' | 'violated' | 'unclear'; severity: 'fail' | 'warn' | 'info'; instructions: string }[];
  verdict: 'pass' | 'warn' | 'fail' | 'unknown';
  backend: string;
  judgeError?: string;
};

export type Sift = {
  // typed questions over any state, answered by the configured backend
  judge: (state: unknown, questions: Record<string, SiftQuestion>) => Promise<SiftJudgement>;
  // run a pack over a subject: an issue or PR number, a commit range, "release", or text
  grade: (pack: string, subject: string, options?: { repo?: string; text?: string }) => Promise<SiftReport>;
  // the backend name in use
  backend: () => string;
};

declare module 'claude-code' {
  interface EngineInterface {
    sift: Sift;
  }
}
