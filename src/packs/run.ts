import { bandOf } from '../judge/bands.ts';
import { DEFAULT_THRESHOLDS, type Judge, type Questions, type Question } from '../judge/types.ts';
import type { RepoConfig } from '../github/config.ts';
import { CHECKS } from './checks.ts';
import type { Finding, Judged, Pack, Report, Subject, Verdict } from './types.ts';

export function materialize(pack: Pack, subject: Subject): { questions: Questions; meta: Record<string, { lo: number; hi: number; severity: Judged['severity']; inverted: boolean }> } {
  const questions: Questions = {};
  const meta: ReturnType<typeof materialize>['meta'] = {};
  const entries = Object.entries(pack.questions);
  if (pack.expand) {
    const list = (subject.facts[pack.expand.from] as { text: string }[] | undefined) ?? [];
    list.forEach((item, i) => {
      const t = pack.expand!.template;
      entries.push([`${pack.expand!.from}_${i + 1}`, { ...t, instructions: t.instructions.replace('{text}', item.text) }]);
    });
  }
  for (const [id, q] of entries) {
    if (q.when && !subject.facts[q.when]) continue;
    const { lo, hi, severity, options, when, inverted, ...question } = q;
    let built: Question;
    if (question.type === 'choice') {
      const set = options ? subject.options[options] : question.criteria;
      if (!set || Object.keys(set).length === 0) continue;
      built = { ...question, criteria: options ? { ...set, none: 'none of the listed options applies' } : set };
    } else {
      built = question;
    }
    questions[id] = built;
    meta[id] = {
      lo: lo ?? DEFAULT_THRESHOLDS.lo,
      hi: hi ?? DEFAULT_THRESHOLDS.hi,
      severity: severity ?? 'warn',
      inverted: inverted ?? false,
    };
  }
  return { questions, meta };
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

export async function runPack(pack: Pack, subject: Subject, judge: Judge, config: RepoConfig): Promise<Report> {
  const mechanical = runChecks(pack, subject, config);
  const { questions, meta } = materialize(pack, subject);
  const judged: Judged[] = [];
  let judgeError: string | undefined;
  let backend = judge.name;
  if (Object.keys(questions).length > 0) {
    const result = await judge.ask(subject.state, questions);
    backend = result.backend;
    if (result.ok) {
      for (const [id, answer] of Object.entries(result.answers)) {
        const m = meta[id]!;
        let band = bandOf(answer, m);
        if (m.inverted && answer.type === 'noul') {
          band = band === 'satisfied' ? 'violated' : band === 'violated' ? 'satisfied' : band;
        }
        judged.push({ id, answer, band, severity: m.severity, instructions: questions[id]!.instructions });
      }
    } else {
      judgeError = `${result.reason}: ${result.message}`;
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
