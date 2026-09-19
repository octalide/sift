import { PACKS_DIR } from '../github/config.ts';
import { BUILTIN_PACKS } from './builtin.ts';
import type { Pack } from './types.ts';

export type FsLike = {
  read: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  list: (path: string) => Promise<{ name: string; kind: string }[]>;
};

export function validatePack(raw: unknown, name: string): Pack {
  if (raw === null || typeof raw !== 'object') throw new Error(`pack ${name}: not an object`);
  const p = raw as Partial<Pack>;
  if (typeof p.subject !== 'string') throw new Error(`pack ${name}: missing subject`);
  if (p.questions !== undefined && (p.questions === null || typeof p.questions !== 'object')) throw new Error(`pack ${name}: questions must be an object`);
  for (const [id, q] of Object.entries(p.questions ?? {})) {
    if (!['noul', 'choice', 'score'].includes(q.type)) throw new Error(`pack ${name}: question ${id} has unknown type ${String(q.type)}`);
    if (typeof q.instructions !== 'string') throw new Error(`pack ${name}: question ${id} has no instructions`);
    if (q.type === 'score' && !Array.isArray(q.criteria)) throw new Error(`pack ${name}: score ${id} needs a criteria array`);
    if (q.type === 'choice' && !q.options && (q.criteria === null || typeof q.criteria !== 'object')) throw new Error(`pack ${name}: choice ${id} needs criteria or options`);
  }
  return {
    name: p.name ?? name,
    subject: p.subject as Pack['subject'],
    description: p.description ?? '',
    checks: Array.isArray(p.checks) ? p.checks : [],
    questions: p.questions ?? {},
    expand: p.expand,
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
