import type { Answer, Band, Question } from '../judge/types.ts';

export type Severity = 'fail' | 'warn' | 'info';

type PackChoice = Omit<Extract<Question, { type: 'choice' }>, 'criteria'> & { criteria?: Record<string, string> };

export type PackQuestion = (Exclude<Question, { type: 'choice' }> | PackChoice) & {
  // band thresholds, DEFAULT_THRESHOLDS when absent
  lo?: number;
  hi?: number;
  // what a violated band means for the verdict
  severity?: Severity;
  // for a choice: name of a subject option set filled at runtime, e.g. "open_issues"
  options?: string;
  // ask only when this subject fact is truthy
  when?: string;
  // for a noul: true when a high probability is the bad outcome (e.g. "scope creep")
  inverted?: boolean;
};

export type SubjectKind = 'issue' | 'pr' | 'commit' | 'release' | 'rules' | 'event' | 'text' | 'message';

export type Pack = {
  name: string;
  subject: SubjectKind;
  description: string;
  checks: string[];
  questions: Record<string, PackQuestion>;
  // generate one question per entry of a subject list (rules): the template's instructions take {text} and {subject}
  expand?: { from: string; template: PackQuestion };
};

export type Finding = {
  check: string;
  severity: Severity;
  message: string;
};

export type Judged = {
  id: string;
  answer: Answer;
  band: Band;
  severity: Severity;
  instructions: string;
};

export type Verdict = 'pass' | 'warn' | 'fail' | 'unknown';

export type Report = {
  pack: string;
  subject: string;
  mechanical: Finding[];
  judged: Judged[];
  verdict: Verdict;
  backend: string;
  judgeError?: string;
};

// what a subject builder hands the pack runner
export type Subject = {
  kind: SubjectKind;
  ref: string;
  // what the judge reads
  state: Record<string, unknown>;
  // what mechanical checks read
  facts: Record<string, unknown>;
  // runtime option sets for choice questions
  options: Record<string, Record<string, string>>;
};
