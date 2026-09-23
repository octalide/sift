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
  // the picks whose confident answer is a finding: for a choice its criteria keys, or listed for every option of its
  // options set (never the added none); for a score its level indices into criteria. without it nothing is violating
  violates?: string[] | number[] | 'listed';
  // ask only when this subject fact is truthy
  when?: string;
  // ask only when this subject fact is falsy
  unless?: string;
  // for a noul: true when a high probability is the bad outcome (e.g. "scope creep")
  inverted?: boolean;
};

export type SubjectKind = 'issue' | 'pr' | 'commit' | 'release' | 'rules' | 'event' | 'text' | 'tree' | 'plan';

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
  // the item field naming it in the report, or a template over its fields ("{n}: {text}"); the item index when absent
  label?: string;
  // how the report lists the step: every item in order (each), the best items by value (top), or only the items it ruled out (violated)
  list?: 'each' | 'top' | 'violated';
  // how a top list is shown: by value, or in input order (a log's lines read in order)
  order?: 'value' | 'input';
  // how many a top list shows, and how many of the items not ruled out survive it
  top?: number;
  // the item fields the state carries beside k, every field when absent; the others only fill the questions
  fields?: string[];
  // the state field the survivors are placed under, read by the steps after it and by the pack's questions
  feed?: string;
  // the state fields the items are read against, the whole state when absent; an isolated step repeats them per item
  context?: string[];
};

export type Pack = {
  name: string;
  subject: SubjectKind;
  description: string;
  checks: string[];
  // asked of the subject state once every rank step has run, with what the steps feed into it
  questions: Record<string, PackQuestion>;
  // ranks over subject lists, run in order before the questions
  rank?: RankStep[];
};

export type Finding = {
  check: string;
  severity: Severity;
  message: string;
};

export type Judged = {
  id: string;
  // absent when the judge left the question unanswered, the band is then unclear
  answer?: Answer;
  band: Band;
  severity: Severity;
  instructions: string;
};

// one item of a rank step: judged on the step's ordering question, with every answer it got and every question
// of the step judged for it (asked, the ordering question among them, each under <step>_<n>.<question>)
export type RankedItem = Judged & { index: number; label: string; answers: Answers; asked: Judged[] };

export type RankedStep = {
  step: string;
  list: 'each' | 'top' | 'violated';
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
  // answers under an id no question asked for, and answers the judge left out of a ranked item, dropped without touching the verdict
  dropped?: number;
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
  // a judge failure while the subject was built: the run asks nothing more and the report carries it
  judgeError?: string;
  // work the subject needs outlasted its wait and keeps running, so the same call made again can answer
  pending?: string;
};
