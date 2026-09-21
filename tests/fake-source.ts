import type { Judge } from '../src/judge/types.ts';
import type { StoreLike } from '../src/log.ts';
import type { RuleSource } from '../src/rules/discover.ts';

// a rule source over a map of path to text, with optional forge templates and remote files keyed repo:path@ref
export function memorySource(files: Record<string, string>, extra: { templates?: Record<string, string>; remote?: Record<string, string>; scope?: string } = {}): RuleSource {
  return {
    scope: extra.scope ?? 'mem',
    list: async () => Object.keys(files),
    read: async (p) => files[p],
    templates: async () => Object.entries(extra.templates ?? {}).map(([path, text]) => ({ path, text })),
    remote: async (repo, path, ref) => extra.remote?.[`${repo}:${path}@${ref}`],
  };
}

export function memoryStore(map = new Map<string, unknown>()): StoreLike & { map: Map<string, unknown> } {
  return { map, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, JSON.parse(JSON.stringify(v))) };
}

// a judge that answers every noul with p, and records what it was asked
export function yesJudge(p = 0.9, asked: { state: unknown; instructions: string[] }[] = []): Judge {
  return {
    name: 'fake',
    ask: async (state, q) => {
      asked.push({ state, instructions: Object.values(q).map((x) => x.instructions) });
      return { ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'noul' as const, p }])) };
    },
  };
}
