import type { Answer, Answers, Judge, JudgeFailure, Question, Questions, Usage } from './types.ts';
import { estimateTokensOf, JEV_LIMITS } from '../tokens.ts';
import { pool } from '../pool.ts';

// batched fills one state with as many items as fit and asks one question set per item, so items can see each other;
// isolated sends one request per item, so no item colours another
export type RankMode = 'batched' | 'isolated';

export type RankItem = string | Record<string, unknown>;

export type RankOptions = {
  mode: RankMode;
  // state every item is read against, placed beside the items
  context?: Record<string, unknown>;
  // the question the sorted view orders by, the first question when absent
  by?: string;
  // for a choice question: the key whose probability orders the view, the chosen key's confidence when absent
  choice?: string;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  // requests in flight at once
  concurrency?: number;
  // the item fields the state carries beside k, every field when absent; every field still fills the questions
  fields?: string[];
};

export const RANK_DEFAULTS = {
  maxStateTokens: JEV_LIMITS.stateTokens,
  maxRequestTokens: JEV_LIMITS.requestTokens,
  concurrency: 8,
};

export type Ranked<T extends RankItem> = { index: number; item: T; answers: Answers; value: number };

export type RankResult<T extends RankItem> =
  // dropped: answers under a key no item or question of the request owns
  | { ok: true; items: Ranked<T>[]; sorted: Ranked<T>[]; requests: number; dropped: number; backend: string; usage?: Usage }
  | { ok: false; reason: JudgeFailure; message: string; backend: string; requests: number };

// what an item looks like in the state: its index as k, a string under text, an object's own fields
export type Entry = { k: number } & Record<string, unknown>;

export function entryOf(item: RankItem, index: number): Entry {
  if (typeof item === 'string') return { k: index, text: item };
  const { k: _k, ...fields } = item;
  return { k: index, ...fields };
}

// the entry as the state shows it: k and the named fields, or the whole entry
export function stateEntry(entry: Entry, fields: string[] | undefined): Entry {
  if (!fields) return entry;
  const out: Entry = { k: entry.k };
  for (const f of fields) if (f !== 'k' && entry[f] !== undefined) out[f] = entry[f];
  return out;
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// {k} and {field} in a question's text take the entry's values; a placeholder the entry has no value for stays as written
export function fill(text: string, entry: Entry): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const v = entry[name];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : whole;
  });
}

export function fillQuestion(question: Question, entry: Entry): Question {
  const instructions = fill(question.instructions, entry);
  switch (question.type) {
    case 'noul':
      return question.criteria
        ? { ...question, instructions, criteria: { true: fill(question.criteria.true, entry), false: fill(question.criteria.false, entry) } }
        : { ...question, instructions };
    case 'choice':
      return { ...question, instructions, criteria: Object.fromEntries(Object.entries(question.criteria).map(([k, v]) => [k, fill(v, entry)])) };
    case 'score':
      return { ...question, instructions, criteria: question.criteria.map((c) => fill(c, entry)) };
  }
}

// batched keys: the question id with the item index behind an underscore, read back by splitting on the last one
export function keyOf(id: string, index: number): string {
  return `${id}_${index}`;
}

export function splitKey(key: string): { id: string; index: number } | undefined {
  const at = key.lastIndexOf('_');
  if (at < 0) return undefined;
  const index = Number(key.slice(at + 1));
  return Number.isInteger(index) && index >= 0 ? { id: key.slice(0, at), index } : undefined;
}

export function questionsFor(questions: Questions, entry: Entry, keyed: boolean): Questions {
  const out: Questions = {};
  for (const [id, q] of Object.entries(questions)) out[keyed ? keyOf(id, entry.k) : id] = fillQuestion(q, entry);
  return out;
}

// fills batches with items until the state or the whole request would pass its budget; an item too large for either goes alone
export function batchEntries(entries: Entry[], questions: Questions, context: Record<string, unknown>, maxStateTokens: number, maxRequestTokens: number, fields?: string[]): Entry[][] {
  const base = estimateTokensOf({ ...context, items: [] });
  const groups: Entry[][] = [];
  let current: Entry[] = [];
  let state = base;
  let request = base;
  for (const entry of entries) {
    const s = estimateTokensOf(stateEntry(entry, fields)) + 4;
    const q = estimateTokensOf(questionsFor(questions, entry, true)) + 8;
    if (current.length > 0 && (state + s > maxStateTokens || request + s + q > maxRequestTokens)) {
      groups.push(current);
      current = [];
      state = base;
      request = base;
    }
    current.push(entry);
    state += s;
    request += s + q;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// the number an answer sorts by: a noul's probability, a score's expected level, a choice's named key or its confidence
export function valueOf(answer: Answer | undefined, choice?: string): number {
  if (!answer) return 0;
  if (answer.type === 'noul') return answer.p;
  if (answer.type === 'score') return answer.expected;
  return choice === undefined ? answer.confidence : (answer.probabilities[choice] ?? 0);
}

function sumUsage(usages: (Usage | undefined)[]): Usage | undefined {
  const known = usages.filter((u): u is Usage => u !== undefined);
  if (known.length === 0) return undefined;
  return {
    requestTokens: known.reduce((n, u) => n + u.requestTokens, 0),
    responseTokens: known.reduce((n, u) => n + u.responseTokens, 0),
    source: known.every((u) => u.source === 'backend') ? 'backend' : 'estimate',
  };
}

// one request per batch: the state holds the context and the batch, the questions one filled set per item
type Request = { state: Record<string, unknown>; questions: Questions; owners: (key: string) => { index: number; id: string } | undefined };

function requestsFor(entries: Entry[], questions: Questions, options: RankOptions): Request[] {
  const context = options.context ?? {};
  if (options.mode === 'isolated') {
    return entries.map((entry) => ({
      state: { ...context, item: stateEntry(entry, options.fields) },
      questions: questionsFor(questions, entry, false),
      owners: (key) => ({ index: entry.k, id: key }),
    }));
  }
  const groups = batchEntries(entries, questions, context, options.maxStateTokens ?? RANK_DEFAULTS.maxStateTokens, options.maxRequestTokens ?? RANK_DEFAULTS.maxRequestTokens, options.fields);
  return groups.map((group) => ({
    state: { ...context, items: group.map((entry) => stateEntry(entry, options.fields)) },
    questions: Object.assign({}, ...group.map((entry) => questionsFor(questions, entry, true))) as Questions,
    owners: splitKey,
  }));
}

export async function rank<T extends RankItem>(items: T[], questions: Questions, judge: Judge, options: RankOptions): Promise<RankResult<T>> {
  const ids = Object.keys(questions);
  const by = options.by ?? ids[0];
  if (by === undefined || !ids.includes(by)) {
    return { ok: false, reason: 'rejected', message: by === undefined ? 'rank needs at least one question' : `no question ${by} to sort by`, backend: judge.name, requests: 0 };
  }
  const entries = items.map(entryOf);
  const requests = requestsFor(entries, questions, options);
  const results = await pool(requests, options.concurrency ?? RANK_DEFAULTS.concurrency, (r) => judge.ask(r.state, r.questions));
  const answers: Answers[] = items.map(() => ({}));
  let backend = judge.name;
  let dropped = 0;
  for (const [i, result] of results.entries()) {
    backend = result.backend;
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message, backend, requests: requests.length };
    for (const [key, answer] of Object.entries(result.answers)) {
      const owner = requests[i]!.owners(key);
      const slot = owner && ids.includes(owner.id) ? answers[owner.index] : undefined;
      if (owner && slot) slot[owner.id] = answer;
      else dropped++;
    }
  }
  const ranked = items.map((item, index) => ({ index, item, answers: answers[index]!, value: valueOf(answers[index]![by], options.choice) }));
  const sorted = [...ranked].sort((a, b) => b.value - a.value || a.index - b.index);
  return { ok: true, items: ranked, sorted, requests: requests.length, dropped, backend, usage: sumUsage(results.map((r) => r.usage)) };
}
