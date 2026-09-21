import { bandOf } from '../judge/bands.ts';
import { entryOf, fill, fillQuestion, rank } from '../judge/rank.ts';
import { DEFAULT_THRESHOLDS, type Answer, type Judge, type Questions, type Question } from '../judge/types.ts';
import type { RepoConfig } from '../github/config.ts';
import { CHECKS } from './checks.ts';
import type { Finding, Judged, Pack, PackQuestion, RankedItem, RankedStep, RankStep, Report, Subject, Verdict } from './types.ts';
import { batchQuestions, estimateTokensOf, JEV_LIMITS } from '../tokens.ts';

type Meta = { lo: number; hi: number; severity: Judged['severity']; inverted: boolean };

// a rank step as rank input: the subject list as items, the questions asked of each with {subject} already filled
export type Step = { step: RankStep; items: Record<string, unknown>[]; questions: Questions; meta: Record<string, Meta>; by: string };

export type Materialized = { questions: Questions; meta: Record<string, Meta>; steps: Step[] };

export type RunOptions = {
  // how many items a top list shows, over every step's own setting
  top?: number;
};

export const TOP_DEFAULT = 20;

function buildQuestion(q: PackQuestion, subject: Subject): { question: Question; meta: Meta } | undefined {
  const { lo, hi, severity, options, when, inverted, ...question } = q;
  let built: Question;
  if (question.type === 'choice') {
    const set = options ? subject.options[options] : question.criteria;
    if (!set || Object.keys(set).length === 0) return undefined;
    built = { ...question, criteria: options ? { ...set, none: 'none of the listed options applies' } : set };
  } else {
    built = question;
  }
  return {
    question: built,
    meta: { lo: lo ?? DEFAULT_THRESHOLDS.lo, hi: hi ?? DEFAULT_THRESHOLDS.hi, severity: severity ?? 'warn', inverted: inverted ?? false },
  };
}

export function materialize(pack: Pack, subject: Subject): Materialized {
  const questions: Questions = {};
  const meta: Record<string, Meta> = {};
  for (const [id, q] of Object.entries(pack.questions)) {
    if (q.when && !subject.facts[q.when]) continue;
    const built = buildQuestion(q, subject);
    if (!built) continue;
    questions[id] = built.question;
    meta[id] = built.meta;
  }
  const label = typeof subject.facts['subject'] === 'string' ? subject.facts['subject'] : 'The subject';
  const steps: Step[] = [];
  for (const step of pack.rank ?? []) {
    const items = (subject.facts[step.from] as Record<string, unknown>[] | undefined) ?? [];
    const stepQuestions: Questions = {};
    const stepMeta: Record<string, Meta> = {};
    for (const [id, q] of Object.entries(step.questions)) {
      // {subject} is the pack's own placeholder, the item's fields are filled by rank per item
      const built = buildQuestion({ ...q, instructions: q.instructions.replace('{subject}', label) }, subject);
      if (!built) continue;
      stepQuestions[id] = built.question;
      stepMeta[id] = built.meta;
    }
    const by = step.by ?? Object.keys(stepQuestions)[0];
    if (by === undefined || !stepQuestions[by]) continue;
    steps.push({ step, items, questions: stepQuestions, meta: stepMeta, by });
  }
  return { questions, meta, steps };
}

export function runChecks(pack: Pack, subject: Subject, config: RepoConfig): Finding[] {
  const findings: Finding[] = [];
  for (const name of pack.checks) {
    const check = CHECKS[name];
    if (!check) {
      findings.push({ check: name, severity: 'info', message: `unknown check ${name}` });
      continue;
    }
    findings.push(...check(subject, config));
  }
  return findings;
}

export function verdictOf(mechanical: Finding[], judged: Judged[], judgeFailed: boolean): Verdict {
  let verdict: Verdict = 'pass';
  const bump = (to: Verdict) => {
    const order: Verdict[] = ['pass', 'unknown', 'warn', 'fail'];
    if (order.indexOf(to) > order.indexOf(verdict)) verdict = to;
  };
  for (const f of mechanical) if (f.severity !== 'info') bump(f.severity);
  for (const j of judged) {
    if (j.band === 'violated') bump(j.severity === 'info' ? 'pass' : j.severity);
    else if (j.band === 'unclear' && j.severity === 'fail') bump('warn');
  }
  if (judgeFailed) bump('unknown');
  return verdict;
}

function judge(id: string, answer: Answer, m: Meta, instructions: string): Judged {
  let band = bandOf(answer, m);
  if (m.inverted && answer.type === 'noul') {
    band = band === 'satisfied' ? 'violated' : band === 'violated' ? 'satisfied' : band;
  }
  return { id, answer, band, severity: m.severity, instructions };
}

// the items of a step narrowed to those under an item the previous step did not rule out
export function narrow(items: Record<string, unknown>[], within: RankStep['within'], previous: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!within) return items;
  const kept = new Set(previous.map((item) => item[within.of]));
  return items.filter((item) => kept.has(item[within.field]));
}

function labelOf(step: RankStep, item: Record<string, unknown>, index: number): string {
  if (step.label?.includes('{')) return fill(step.label, entryOf(item, index));
  const v = step.label ? item[step.label] : undefined;
  return typeof v === 'string' || typeof v === 'number' ? String(v) : String(index + 1);
}

type StepResult = { ranked: RankedStep; kept: Record<string, unknown>[]; dropped: number; backend: string } | { error: string; backend: string };

// the items a step did not rule out, in input order: every band but violated, and for a top list no more than the top shows
async function runStep(s: Step, items: Record<string, unknown>[], state: Record<string, unknown>, judgeBackend: Judge, top: number | undefined): Promise<StepResult> {
  const list = s.step.list ?? 'each';
  if (items.length === 0) return { ranked: { step: s.step.from, list, total: 0, kept: 0, items: [] }, kept: [], dropped: 0, backend: judgeBackend.name };
  const result = await rank(items, s.questions, judgeBackend, { mode: s.step.mode ?? 'batched', context: state, by: s.by, fields: s.step.fields });
  if (!result.ok) return { backend: result.backend, error: `${result.reason}: ${result.message}` };
  const all = result.items.map((r) => {
    const asked = fillQuestion(s.questions[s.by]!, entryOf(r.item, r.index));
    const judged: RankedItem = { ...judge(`${s.step.from}_${r.index + 1}`, r.answers[s.by]!, s.meta[s.by]!, asked.instructions), index: r.index, label: labelOf(s.step, r.item, r.index), answers: r.answers };
    return { judged, item: r.item, value: r.value };
  });
  const byIndex = (a: { judged: RankedItem }, b: { judged: RankedItem }) => a.judged.index - b.judged.index;
  const byValue = [...all].sort((a, b) => b.value - a.value || byIndex(a, b));
  const best = list === 'top' ? byValue.slice(0, top ?? s.step.top ?? TOP_DEFAULT) : all;
  const shown = s.step.order === 'input' ? [...best].sort(byIndex) : best;
  const kept = best.filter((r) => r.judged.band !== 'violated').sort(byIndex);
  return { ranked: { step: s.step.from, list, total: items.length, kept: kept.length, items: shown.map((r) => r.judged) }, kept: kept.map((r) => r.item), dropped: result.dropped, backend: result.backend };
}

export async function runPack(pack: Pack, subject: Subject, judgeBackend: Judge, config: RepoConfig, options: RunOptions = {}): Promise<Report> {
  const mechanical = runChecks(pack, subject, config);
  const { questions, meta, steps } = materialize(pack, subject);
  const judged: Judged[] = [];
  const ranked: RankedStep[] = [];
  let judgeError = subject.judgeError;
  let backend = judgeBackend.name;
  // an answer to a question the request did not ask is dropped and counted, never indexed
  let dropped = 0;
  // each step is one batched rank over its list, the state so far as the context, narrowed by the step before it;
  // a step with feed places its survivors in the state for the steps and questions after it
  const state: Record<string, unknown> = { ...subject.state };
  let kept: Record<string, unknown>[] = [];
  for (const s of steps) {
    if (judgeError !== undefined) break;
    const out = await runStep(s, narrow(s.items, s.step.within, kept), state, judgeBackend, options.top);
    backend = out.backend;
    if ('error' in out) {
      judgeError = out.error;
      break;
    }
    ranked.push(out.ranked);
    kept = out.kept;
    dropped += out.dropped;
    if (s.step.feed) state[s.step.feed] = kept;
  }
  // a pack with many questions goes out in several requests, the state repeated in each
  for (const batch of judgeError === undefined ? batchQuestions(questions, estimateTokensOf(state), JEV_LIMITS.requestTokens) : []) {
    const result = await judgeBackend.ask(state, batch);
    backend = result.backend;
    if (!result.ok) {
      judgeError = `${result.reason}: ${result.message}`;
      break;
    }
    for (const [id, answer] of Object.entries(result.answers)) {
      const m = meta[id];
      const q = batch[id];
      if (!m || !q) {
        dropped++;
        continue;
      }
      judged.push(judge(id, answer, m, q.instructions));
    }
  }
  return {
    pack: pack.name,
    subject: subject.ref,
    mechanical,
    judged,
    ranked,
    verdict: verdictOf(mechanical, [...judged, ...ranked.flatMap((r) => r.items)], judgeError !== undefined),
    backend,
    judgeError,
    ...(dropped > 0 ? { dropped } : {}),
  };
}

export function formatReport(report: Report): string {
  const lines = [`sift ${report.pack} ${report.subject}: ${report.verdict.toUpperCase()} (judge: ${report.backend})`];
  for (const f of report.mechanical) lines.push(`  [${f.severity}] ${f.check}: ${f.message}`);
  const value = (j: Judged) =>
    j.answer.type === 'noul'
      ? j.answer.p.toFixed(2)
      : j.answer.type === 'choice'
        ? `${j.answer.choice} (${j.answer.confidence.toFixed(2)})`
        : `${j.answer.legend} (${j.answer.confidence.toFixed(2)})`;
  // steps first, then the questions, the order they ran in
  for (const r of report.ranked) {
    if (r.list === 'each') {
      for (const j of r.items) lines.push(`  [${j.band}] ${j.id} = ${value(j)}: ${j.instructions}`);
      continue;
    }
    lines.push(`  ${r.step}: top ${r.items.length} of ${r.total}, ${r.kept} not ruled out`);
    for (const [i, j] of r.items.entries()) lines.push(`    ${i + 1}. [${j.band}] ${j.label} = ${value(j)}`);
  }
  for (const j of report.judged) lines.push(`  [${j.band}] ${j.id} = ${value(j)}: ${j.instructions}`);
  if (report.judgeError) lines.push(`  judge unavailable: ${report.judgeError}`);
  if (report.dropped) lines.push(`  judge answered ${report.dropped} question${report.dropped === 1 ? '' : 's'} it was not asked, dropped`);
  return lines.join('\n');
}
