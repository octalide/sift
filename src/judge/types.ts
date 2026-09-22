// criteria is jev's shape: what a yes and a no mean
export type NoulCriteria = { true: string; false: string };

export type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: NoulCriteria;
};

export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: 'score';
  instructions: string;
  criteria: string[];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export type NoulAnswer = { type: 'noul'; p: number };
export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
// score is the most likely level index, expected the probability-weighted position between levels
export type ScoreAnswer = {
  type: 'score';
  score: number;
  expected: number;
  legend: string;
  probabilities: number[];
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Answers = Record<string, Answer>;

export type JudgeFailure = 'disabled' | 'unavailable' | 'rejected' | 'malformed';

// where the jev key came from: the apiKey option, TYPESAFE_API_KEY in the environment, or the settings env block
export type KeySource = 'option' | 'env' | 'settings';

export const KEY_SOURCE_LABEL: Record<KeySource, string> = {
  option: 'the apiKey option',
  env: 'TYPESAFE_API_KEY in the environment',
  settings: 'TYPESAFE_API_KEY in the settings env block',
};

// what a call cost: the backend's own count when it reports one, else an estimate from the bytes sent and received
export type Usage = { requestTokens: number; responseTokens: number; source: 'backend' | 'estimate' };

export type Judgement =
  | { ok: true; answers: Answers; backend: string; latencyMs: number; usage?: Usage }
  | { ok: false; reason: JudgeFailure; message: string; backend: string; status?: number; keySource?: KeySource; usage?: Usage };

// a failure as one line; keySource is set only when the backend refused the key
export function failureText(f: { reason: JudgeFailure; message: string; keySource?: KeySource }): string {
  return f.keySource ? `${f.reason} (key from ${KEY_SOURCE_LABEL[f.keySource]}): ${f.message}` : `${f.reason}: ${f.message}`;
}

export interface Judge {
  readonly name: string;
  ask(state: unknown, questions: Questions): Promise<Judgement>;
}

export type Band = 'satisfied' | 'violated' | 'unclear';

export type Thresholds = { lo: number; hi: number };

export const DEFAULT_THRESHOLDS: Thresholds = { lo: 0.35, hi: 0.65 };
