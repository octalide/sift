import { digest } from '../hash.ts';
import type { Judge } from '../judge/types.ts';
import type { StoreLike } from '../log.ts';
import type { Pack, Subject } from '../packs/types.ts';
import type { Outbound } from './outbound.ts';

// bump when what a kept verdict holds, or how the gate reads a report into one, changes
const VERSION = 1;
const KEY = 'outbound-verdicts';
const MAX = 500;

// what the gate decided on text it judged in full
export type Verdict = { allow: boolean; reason: string; warnings: string[] };

type Entry = Verdict & { key: string };

// everything a verdict reads: the text, what it is and where it goes, every part of it with the rules it was judged
// against, the questions asked of them and the judge that answered
export function verdictKey(out: Outbound, subjects: Subject[], pack: Pack, judge: Judge): string {
  const parts = subjects.map((s) => ({ state: s.state, rules: s.facts['rules'] }));
  return digest(JSON.stringify({ v: VERSION, channel: out.channel, kind: out.kind, text: out.text, parts, pack: { questions: pack.questions, rank: pack.rank }, judge: judge.name }));
}

// the gate's verdicts, kept in the store every session shares. a judge's answers near a band's edge vary between asks,
// and text sent again unchanged must meet the verdict it met before, so a verdict is answered again for the same key.
// the last MAX are kept
export class Verdicts {
  constructor(private readonly store: StoreLike) {}

  async get(key: string): Promise<Verdict | undefined> {
    const found = (await this.entries()).find((e) => e.key === key);
    return found ? { allow: found.allow, reason: found.reason, warnings: found.warnings } : undefined;
  }

  async set(key: string, verdict: Verdict): Promise<void> {
    const rest = (await this.entries()).filter((e) => e.key !== key);
    await this.store.set(KEY, [...rest, { key, ...verdict }].slice(-MAX));
  }

  // every kept verdict, so text a wrong one met is judged afresh
  async clear(): Promise<void> {
    await this.store.set(KEY, []);
  }

  private async entries(): Promise<Entry[]> {
    const got = await this.store.get(KEY);
    return Array.isArray(got) ? (got as Entry[]) : [];
  }
}
