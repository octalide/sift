import { bandOf } from '../judge/bands.ts';
import { entryOf, fillQuestion, rank } from '../judge/rank.ts';
import { DEFAULT_THRESHOLDS, type Answer, type Judge, type Questions, type Question } from '../judge/types.ts';
import type { RepoConfig } from '../github/config.ts';
import { CHECKS } from './checks.ts';
import type { Finding, Judged, Pack, PackQuestion, Report, Subject, Verdict } from './types.ts';
import { batchQuestions, estimateTokensOf, JEV_LIMITS } from '../tokens.ts';

type Meta = { lo: number; hi: number; severity: Judged['severity']; inverted: boolean };

// a pack's expansion as rank input: the subject list as items, the template as the one question asked of each
export type Expansion = { id: string; items: Record<string, unknown>[]; questions: Questions; meta: Meta };

export type Materialized = { questions: Questions; meta: Record<string, Meta>; expansion?: Expansion };

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
  let expansion: Expansion | undefined;
  if (pack.expand) {
    const items = (subject.facts[pack.expand.from] as Record<string, unknown>[] | undefined) ?? [];
    const label = typeof subject.facts['subject'] === 'string' ? subject.facts['subject'] : 'The subject';
    const t = pack.expand.template;
    // {subject} is the pack's own placeholder, {text} and the item's other fields are filled by rank per item
    const built = buildQuestion({ ...t, instructions: t.instructions.replace('{subject}', label) }, subject);
    if (built) expansion = { id: pack.expand.from, items, questions: { [pack.expand.from]: built.question }, meta: built.meta };
  }
  return { questions, meta, expansion };
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

export async function runPack(pack: Pack, subject: Subject, judgeBackend: Judge, config: RepoConfig): Promise<Report> {
  const mechanical = runChecks(pack, subject, config);
  const { questions, meta, expansion } = materialize(pack, subject);
  const judged: Judged[] = [];
  let judgeError: string | undefined;
  let backend = judgeBackend.name;
  // a pack with many questions goes out in several requests, the state repeated in each
  for (const batch of batchQuestions(questions, estimateTokensOf(subject.state), JEV_LIMITS.requestTokens)) {
    const result = await judgeBackend.ask(subject.state, batch);
    backend = result.backend;
    if (!result.ok) {
      judgeError = `${result.reason}: ${result.message}`;
      break;
    }
    for (const [id, answer] of Object.entries(result.answers)) judged.push(judge(id, answer, meta[id]!, questions[id]!.instructions));
  }
  // an expanded list (rules over a long doc) is ranked in batches, the subject state as the context of each
  if (expansion && expansion.items.length > 0 && judgeError === undefined) {
    const ranked = await rank(expansion.items, expansion.questions, judgeBackend, { mode: 'batched', context: subject.state });
    backend = ranked.backend;
    if (!ranked.ok) {
      judgeError = `${ranked.reason}: ${ranked.message}`;
    } else {
      for (const r of ranked.items) {
        const answer = r.answers[expansion.id]!;
        const asked = fillQuestion(expansion.questions[expansion.id]!, entryOf(r.item, r.index));
        judged.push(judge(`${expansion.id}_${r.index + 1}`, answer, expansion.meta, asked.instructions));
      }
    }
  }
  return {
    pack: pack.name,
    subject: subject.ref,
    mechanical,
    judged,
    verdict: verdictOf(mechanical, judged, judgeError !== undefined),
    backend,
    judgeError,
  };
}

export function formatReport(report: Report): string {
  const lines = [`sift ${report.pack} ${report.subject}: ${report.verdict.toUpperCase()} (judge: ${report.backend})`];
  for (const f of report.mechanical) lines.push(`  [${f.severity}] ${f.check}: ${f.message}`);
  for (const j of report.judged) {
    const value =
      j.answer.type === 'noul'
        ? j.answer.p.toFixed(2)
        : j.answer.type === 'choice'
          ? `${j.answer.choice} (${j.answer.confidence.toFixed(2)})`
          : `${j.answer.legend} (${j.answer.confidence.toFixed(2)})`;
    lines.push(`  [${j.band}] ${j.id} = ${value}: ${j.instructions}`);
  }
  if (report.judgeError) lines.push(`  judge unavailable: ${report.judgeError}`);
  return lines.join('\n');
}
