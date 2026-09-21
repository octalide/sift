import type { Answer, Answers, Band, Question } from '../judge/types.ts';
import type { RankMode } from '../judge/rank.ts';

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

export type SubjectKind = 'issue' | 'pr' | 'commit' | 'release' | 'rules' | 'event' | 'text' | 'tree';

// one rank over a subject list: every item is asked the step's questions, the subject state as context.
// {field} in a question takes the item's field, {subject} the subject's own label
export type RankStep = {
  // the subject fact holding the items, each a record
  from: string;
  questions: Record<string, PackQuestion>;
  // batched when absent
  mode?: RankMode;
  // the question whose value orders and bands the items, the first when absent
  by?: string;
  // hierarchy: keep only items whose field equals the field of an item the previous step did not rule out
  within?: { field: string; of: string };
  // the item field naming it in the report, the item index when absent
  label?: string;
  // how the report lists the step: every item in order (each), or the best items by value (top)
  list?: 'each' | 'top';
  // how many a top list shows
  top?: number;
};

export type Pack = {
  name: string;
  subject: SubjectKind;
  description: string;
  checks: string[];
  questions: Record<string, PackQuestion>;
  // ranks over subject lists, run in order after the questions
  rank?: RankStep[];
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

// one item of a rank step: judged on the step's ordering question, with every answer it got
export type RankedItem = Judged & { index: number; label: string; answers: Answers };

export type RankedStep = {
  step: string;
  list: 'each' | 'top';
  // items the step was asked about, and how many it did not rule out
  total: number;
  kept: number;
  items: RankedItem[];
};

export type Verdict = 'pass' | 'warn' | 'fail' | 'unknown';

export type Report = {
  pack: string;
  subject: string;
  mechanical: Finding[];
  judged: Judged[];
  ranked: RankedStep[];
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
