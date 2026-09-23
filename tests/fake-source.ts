import type { Judge } from '../src/judge/types.ts';
import { Discoveries, type DiscoveriesHost, type RuleSource } from '../src/rules/discover.ts';
import type { KeyStore } from '../src/keys.ts';

// a rule source over a map of path to text, with templates beside the files, ids for the files that have one, and
// remote files keyed repo:path@ref
export function memorySource(files: Record<string, string>, extra: { templates?: Record<string, string>; ids?: Record<string, string>; remote?: Record<string, string>; scope?: string } = {}): RuleSource {
  const all: Record<string, string> = { ...files, ...extra.templates };
  return {
    scope: extra.scope ?? 'mem',
    list: async () => Object.keys(all).map((path) => (extra.ids?.[path] === undefined ? { path } : { path, id: extra.ids[path] })),
    read: async (p) => all[p],
    template: (p) => p in (extra.templates ?? {}),
    remote: async (repo, path, ref) => extra.remote?.[`${repo}:${path}@${ref}`],
  };
}

// the discoveries a test's rules are read through; the wait never ends unless the test's own schedule ends it
export function discoveries(judge: Judge, store = memoryStore(), opts: { now?: () => number; log?: (text: string) => void; schedule?: DiscoveriesHost['schedule']; waitMs?: number } = {}): Discoveries {
  return new Discoveries({ judge, store, now: opts.now ?? (() => 1), log: opts.log ?? (() => {}), schedule: opts.schedule ?? (() => ({ cancel: () => {} })), waitMs: opts.waitMs ?? 5_000 });
}

export function memoryStore(map = new Map<string, unknown>()): KeyStore & { map: Map<string, unknown> } {
  return { map, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, JSON.parse(JSON.stringify(v))), delete: async (k) => void map.delete(k), keys: async () => [...map.keys()] };
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
