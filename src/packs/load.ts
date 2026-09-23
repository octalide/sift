import { PACKS_DIR } from '../repo/config.ts';
import { BUILTIN_PACKS } from './builtin.ts';
import type { Pack, PackQuestion, RankStep } from './types.ts';

export type FsLike = {
  read: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  list: (path: string) => Promise<{ name: string; kind: string }[]>;
};

function isNoulCriteria(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return typeof c['true'] === 'string' && typeof c['false'] === 'string';
}

function validateQuestions(raw: unknown, name: string, where: string): Record<string, PackQuestion> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object') throw new Error(`pack ${name}: ${where} must be an object`);
  for (const [id, q] of Object.entries(raw as Record<string, PackQuestion>)) {
    if (!['noul', 'choice', 'score'].includes(q.type)) throw new Error(`pack ${name}: question ${id} has unknown type ${String(q.type)}`);
    if (typeof q.instructions !== 'string') throw new Error(`pack ${name}: question ${id} has no instructions`);
    if (q.type === 'score' && !Array.isArray(q.criteria)) throw new Error(`pack ${name}: score ${id} needs a criteria array`);
    if (q.type === 'noul' && q.criteria !== undefined && !isNoulCriteria(q.criteria)) throw new Error(`pack ${name}: noul ${id} criteria must be { true, false } strings`);
    if (q.type === 'choice' && !q.options && (q.criteria === null || typeof q.criteria !== 'object')) throw new Error(`pack ${name}: choice ${id} needs criteria or options`);
    if (q.violates !== undefined) {
      if (q.type !== 'choice') throw new Error(`pack ${name}: violates on ${id} needs a choice`);
      if (q.violates === 'listed' ? !q.options : !Array.isArray(q.violates) || !q.violates.every((k) => typeof k === 'string')) {
        throw new Error(`pack ${name}: choice ${id} violates must be a list of option keys, or listed with options`);
      }
    }
  }
  return raw as Record<string, PackQuestion>;
}

function validateRank(raw: unknown, name: string): RankStep[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`pack ${name}: rank must be an array of steps`);
  return raw.map((step: Partial<RankStep>, i) => {
    if (step === null || typeof step !== 'object' || typeof step.from !== 'string') throw new Error(`pack ${name}: rank step ${i + 1} needs from`);
    const questions = validateQuestions(step.questions, name, `rank step ${i + 1} questions`);
    if (Object.keys(questions).length === 0) throw new Error(`pack ${name}: rank step ${i + 1} needs at least one question`);
    if (step.by !== undefined && !questions[step.by]) throw new Error(`pack ${name}: rank step ${i + 1} sorts by unknown question ${step.by}`);
    if (step.within !== undefined && (typeof step.within.field !== 'string' || typeof step.within.of !== 'string')) throw new Error(`pack ${name}: rank step ${i + 1} within needs field and of`);
    if (step.list !== undefined && !['each', 'top', 'violated'].includes(step.list)) throw new Error(`pack ${name}: rank step ${i + 1} list must be each, top or violated`);
    if (step.order !== undefined && !['value', 'input'].includes(step.order)) throw new Error(`pack ${name}: rank step ${i + 1} order must be value or input`);
    if (step.feed !== undefined && (typeof step.feed !== 'string' || step.feed === '')) throw new Error(`pack ${name}: rank step ${i + 1} feed must name a state field`);
    if (step.context !== undefined && (!Array.isArray(step.context) || !step.context.every((f) => typeof f === 'string'))) throw new Error(`pack ${name}: rank step ${i + 1} context must be an array of state fields`);
    return { ...step, from: step.from, questions };
  });
}

export function validatePack(raw: unknown, name: string): Pack {
  if (raw === null || typeof raw !== 'object') throw new Error(`pack ${name}: not an object`);
  const p = raw as Partial<Pack>;
  if (typeof p.subject !== 'string') throw new Error(`pack ${name}: missing subject`);
  if ('expand' in p) throw new Error(`pack ${name}: expand is gone, write it as a rank step: { "rank": [{ "from": "<list>", "questions": { "<id>": <question> } }] }`);
  return {
    name: p.name ?? name,
    subject: p.subject as Pack['subject'],
    description: p.description ?? '',
    checks: Array.isArray(p.checks) ? p.checks : [],
    questions: validateQuestions(p.questions, name, 'questions'),
    rank: validateRank(p.rank, name),
  };
}

// built-in packs, each replaced by a same-named file under .sift/packs when the repo has one
export async function loadPacks(fs: FsLike, root: string): Promise<Record<string, Pack>> {
  const packs: Record<string, Pack> = { ...BUILTIN_PACKS };
  const dir = `${root}/${PACKS_DIR}`;
  if (!(await fs.exists(dir))) return packs;
  for (const entry of await fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
    const name = entry.name.slice(0, -5);
    const raw = JSON.parse(await fs.read(`${dir}/${entry.name}`));
    packs[name] = validatePack(raw, name);
  }
  return packs;
}
