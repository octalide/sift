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

export type Judgement =
  | { ok: true; answers: Answers; backend: string; latencyMs: number }
  | { ok: false; reason: JudgeFailure; message: string; backend: string; status?: number };

export interface Judge {
  readonly name: string;
  ask(state: unknown, questions: Questions): Promise<Judgement>;
}

export type Band = 'satisfied' | 'violated' | 'unclear';

export type Thresholds = { lo: number; hi: number };

export const DEFAULT_THRESHOLDS: Thresholds = { lo: 0.35, hi: 0.65 };
