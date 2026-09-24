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

// a key named without its value: where it came from and its last four characters
export type KeyRef = { source: KeySource; ending: string };

// the key in use, and every other source that holds a key, marked when that key is the same one.
// stored is the file the key in use is kept in, when sift can name it: the session's credentials file for the option
export type KeyOrigin = KeyRef & { others: (KeyRef & { same: boolean })[]; stored?: string };

// what to change when jev rejects the key in use
export function keyFix(origin: KeyOrigin): string {
  switch (origin.source) {
    case 'option': {
      const where = origin.stored ? ` (the option is stored in ${origin.stored}, not in a settings file)` : '';
      return `set a new key in the plugin's options, or clear the option to fall back to TYPESAFE_API_KEY${where}`;
    }
    case 'env':
      return 'export a valid TYPESAFE_API_KEY';
    case 'settings':
      return 'update env.TYPESAFE_API_KEY in the settings file';
  }
}

export function keyRefText(k: KeyRef): string {
  return `${KEY_SOURCE_LABEL[k.source]} (ending ${k.ending})`;
}

// the sources holding a different key than the one in use, as one clause each, empty when they agree
export function shadowedText(origin: KeyOrigin): string[] {
  return origin.others.filter((o) => !o.same).map((o) => `${keyRefText(o)} is set but shadowed`);
}

// what a call cost: the backend's own count when it reports one, else an estimate from the bytes sent and received
export type Usage = { requestTokens: number; responseTokens: number; source: 'backend' | 'estimate' };

export type Judgement =
  | { ok: true; answers: Answers; backend: string; latencyMs: number; usage?: Usage }
  | { ok: false; reason: JudgeFailure; message: string; backend: string; status?: number; key?: KeyOrigin; usage?: Usage };

// a failure as one line; key is set only when the backend rejected the key, and then the line names it and the fix
export function failureText(f: { reason: JudgeFailure; message: string; key?: KeyOrigin }): string {
  if (!f.key) return `${f.reason}: ${f.message}`;
  const clauses = [`jev rejected the key from ${keyRefText(f.key)}`, `fix: ${keyFix(f.key)}`, ...shadowedText(f.key), f.message];
  return `${f.reason}: ${clauses.join('; ')}`;
}

export interface Judge {
  readonly name: string;
  // true once the backend has rejected its key; every later call fails without a request
  readonly keyRejected?: boolean;
  ask(state: unknown, questions: Questions): Promise<Judgement>;
}

export type Band = 'satisfied' | 'violated' | 'unclear';

export type Thresholds = { lo: number; hi: number };

export const DEFAULT_THRESHOLDS: Thresholds = { lo: 0.35, hi: 0.65 };
