import { bandOf } from '../judge/bands.ts';
import { rank } from '../judge/rank.ts';
import { STATE_ROOM } from '../judge/room.ts';
import { DEFAULT_THRESHOLDS, failureText, type Judge, type Questions } from '../judge/types.ts';
import type { Report, Subject } from '../packs/types.ts';
import type { Rule } from '../rules/discover.ts';
import { estimateTokensOf, truncate } from '../tokens.ts';

// a rule the text breaks: the parts it breaks it in, and the lines where it does, none when what breaks it is
// something the text lacks
export type Breach = { rule: Rule; parts: string[]; passages: string[] };

// a rule found broken is asked again beside the rest of its document, the way a reader applies it: a rule for a
// specific case governs that case over a general one, and a rule governs the work a text describes, not a proposal to
// change the rule
export const CONFIRM_QUESTION: Questions = {
  complies: {
    type: 'noul',
    instructions: '{subject} complies with this rule, read beside the other rules of its document in the state: {text}',
    criteria: {
      true: 'The subject follows the rule, or the rule does not govern it: another rule of the same document is written for this specific case and permits it, the subject proposes changing the rule rather than doing the work the rule governs, or the rule is written for another kind of text, or for metadata the subject does not carry.',
      false: 'The subject does something the rule forbids, or lacks something it requires, and no more specific rule of the same document permits it.',
    },
  },
};

// where in the text a confirmed rule is broken, one line at a time, a line too long to quote whole a sentence at a
// time, read beside each other
export const PASSAGE_QUESTION: Questions = {
  at: {
    type: 'noul',
    instructions: 'This line of the text is where it breaks the rule in the state: {text}',
    criteria: {
      true: 'This line says or does what the rule forbids, or is the line that fails what the rule requires of it.',
      false: 'This line does not break the rule, or the text breaks it only by lacking something no line holds.',
    },
  },
};

// the lines quoted per breach, and how much of each
const QUOTED = { lines: 3, width: 160 };
const RULE_WIDTH = 240;
// what the confirm's state may spend on the rest of the documents, after the subject and the rules it asks about
const MARGIN = 1_000;

type Found = { index: number; rule: Rule; parts: string[] };

export type Confirmed = { ok: true; breaches: Breach[]; unclear: Found[] } | { ok: false; error: string };

// the rules a report of the rules pack found broken, each asked again in the part it was broken in beside the other
// rules of its document, and the lines of that part where it breaks, so a refusal names what to fix
export async function confirmBreaches(report: Report, subjects: Subject[], judge: Judge): Promise<Confirmed> {
  const rules = (subjects[0]?.facts['rules'] as Rule[] | undefined) ?? [];
  const found: Found[] = [];
  for (const item of report.ranked[0]?.items ?? []) {
    const hit = item.asked.filter((j) => j.band === 'violated' && j.severity !== 'info');
    if (hit.length === 0 || !rules[item.index]) continue;
    found.push({ index: item.index, rule: rules[item.index]!, parts: hit.flatMap((j) => j.parts ?? []) });
  }
  const byPart = new Map<number, Found[]>();
  for (const f of found) for (const at of subjectsOf(f, subjects)) byPart.set(at, [...(byPart.get(at) ?? []), f]);
  // every part at once, and within one every confirmed rule's lines at once: a refusal costs two judge rounds past the first
  const judged = await Promise.all(
    [...byPart].map(async ([at, asked]) => {
      const subject = subjects[at]!;
      const part = subjects.length > 1 ? partOf(subject, at, subjects.length) : undefined;
      const confirmed = await confirm(subject, asked, rules, judge);
      if (!confirmed.ok) return confirmed;
      const broken = asked.filter((_, i) => confirmed.bands[i] === 'violated');
      const lines = await Promise.all(broken.map((f) => passages(subject, f.rule, judge)));
      const found: string[][] = [];
      for (const l of lines) {
        if (!l.ok) return l;
        found.push(l.passages);
      }
      return { ok: true as const, part, unclear: asked.filter((_, i) => confirmed.bands[i] === 'unclear'), broken: broken.map((f, i) => ({ f, passages: found[i]! })) };
    }),
  );
  const breaches = new Map<number, Breach>();
  const unclear = new Map<number, Found>();
  for (const j of judged) {
    if (!j.ok) return j;
    const inPart = (parts: string[]) => (j.part ? [...parts, j.part] : parts);
    for (const f of j.unclear) unclear.set(f.index, { ...f, parts: inPart(unclear.get(f.index)?.parts ?? []) });
    for (const { f, passages } of j.broken) {
      const b = breaches.get(f.index) ?? { rule: f.rule, parts: [], passages: [] };
      breaches.set(f.index, { rule: f.rule, parts: inPart(b.parts), passages: [...b.passages, ...passages].slice(0, QUOTED.lines) });
    }
  }
  // a rule broken in one part and unclear in another is broken
  return { ok: true, breaches: [...breaches.values()], unclear: [...unclear.values()].filter((u) => !breaches.has(u.index)) };
}

// a breach as the refusal names it: its document, the rule, the parts, and the lines that do not follow it or, when
// none does, that the text lacks what it requires
export function breachText(b: Breach): string {
  const where = b.parts.length > 0 ? ` (in ${b.parts.join(', ')})` : '';
  const quote = (t: string, width: number) => JSON.stringify(truncate(t, width));
  const why = b.passages.length > 0 ? `${b.passages.map((p) => quote(p, QUOTED.width)).join(' and ')} ${b.passages.length === 1 ? 'does' : 'do'} not follow it` : 'the text lacks what it requires';
  return `${b.rule.source} ${quote(b.rule.text, RULE_WIDTH)}${where}: ${why}`;
}

// the subjects a rule was found broken in, by the parts the report names, the only subject when it names none
function subjectsOf(f: Found, subjects: Subject[]): number[] {
  if (subjects.length === 1 || f.parts.length === 0) return [0];
  return subjects.map((s, i) => [s, i] as const).filter(([s, i]) => f.parts.includes(partOf(s, i, subjects.length))).map(([, i]) => i);
}

// the name runParts gives a part
function partOf(s: Subject, i: number, count: number): string {
  return typeof s.facts['part'] === 'string' ? s.facts['part'] : `part ${i + 1} of ${count}`;
}

async function confirm(subject: Subject, asked: Found[], rules: Rule[], judge: Judge): Promise<{ ok: true; bands: ('satisfied' | 'unclear' | 'violated')[] } | { ok: false; error: string }> {
  const sources = new Set(asked.map((f) => f.rule.source));
  const items = asked.map((f) => ({ source: f.rule.source, text: f.rule.text }));
  // the documents' rules in their order, as many as the state holds beside the subject and the rules asked about
  let room = STATE_ROOM - estimateTokensOf(subject.state['subject']) - estimateTokensOf(items) - MARGIN;
  const documents: { source: string; text: string }[] = [];
  for (const r of rules) {
    if (!sources.has(r.source)) continue;
    const entry = { source: r.source, text: r.text };
    room -= estimateTokensOf(entry);
    if (room < 0) break;
    documents.push(entry);
  }
  const label = typeof subject.facts['subject'] === 'string' ? subject.facts['subject'] : 'The subject';
  const questions: Questions = { complies: { ...CONFIRM_QUESTION['complies']!, instructions: CONFIRM_QUESTION['complies']!.instructions.replace('{subject}', label) } };
  const ranked = await rank(items, questions, judge, { mode: 'batched', context: { subject: subject.state['subject'], rules: documents }, fields: ['source'] });
  if (!ranked.ok) return { ok: false, error: failureText(ranked) };
  // an unanswered rule stays unclear: it neither refuses nor clears
  return { ok: true, bands: ranked.items.map((r) => (r.answers['complies'] ? bandOf(r.answers['complies'], DEFAULT_THRESHOLDS) : 'unclear')) };
}

async function passages(subject: Subject, rule: Rule, judge: Judge): Promise<{ ok: true; passages: string[] } | { ok: false; error: string }> {
  const read = subject.state['subject'] as { text?: unknown; about?: unknown; sets?: Record<string, unknown> } | undefined;
  const text = typeof read?.text === 'string' ? read.text : '';
  // what the write sets is quoted as the line a reader would fix, a pull request's base among them
  const lines = [...Object.entries(read?.sets ?? {}).map(([k, v]) => `${k}: ${String(v)}`), ...passagesOf(text)];
  if (lines.length === 0) return { ok: true, passages: [] };
  const context = { rule: { source: rule.source, text: rule.text }, ...(typeof read?.about === 'string' ? { about: read.about } : {}) };
  const ranked = await rank(lines, PASSAGE_QUESTION, judge, { mode: 'batched', context });
  if (!ranked.ok) return { ok: false, error: failureText(ranked) };
  const at = ranked.sorted.filter((r) => r.answers['at'] && bandOf(r.answers['at'], DEFAULT_THRESHOLDS) === 'satisfied');
  return { ok: true, passages: at.slice(0, QUOTED.lines).map((r) => r.item) };
}

// the text's lines, a line longer than a quote split into its sentences, fences left out
export function passagesOf(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('```'))
    .flatMap((l) => (l.length > QUOTED.width ? l.split(/(?<=[.!?:;])\s+/).filter((t) => t.length > 0) : [l]));
}
