import { digest } from '../hash.ts';
import type { Judge } from '../judge/types.ts';
import type { StoreLike } from '../log.ts';
import type { Pack, Subject } from '../packs/types.ts';
import { CONFIRM_QUESTION, PASSAGE_QUESTION } from './breaches.ts';
import type { Outbound } from './outbound.ts';

// bump when what a kept verdict holds, or how the gate reads a report into one, changes
const VERSION = 2;
const KEY = 'outbound-verdicts';
const MAX = 500;
// verdicts settled without being kept, waiting for the call that settles on them
const MAX_UNKEPT = 100;

// what the gate decided on text it judged in full
export type Verdict = { allow: boolean; reason: string; warnings: string[] };

type Entry = Verdict & { key: string };

// everything a verdict reads: the text, what it is and where it goes, every part of it with the rules it was judged
// against (each with its scope), the questions asked of them, the questions a breach is confirmed and located by, and
// the judge that answered
export function verdictKey(out: Outbound, subjects: Subject[], pack: Pack, judge: Judge): string {
  const parts = subjects.map((s) => ({ state: s.state, rules: s.facts['rules'] }));
  return digest(JSON.stringify({ v: VERSION, channel: out.channel, kind: out.kind, textKind: out.textKind, sets: out.sets, text: out.text, parts, pack: { questions: pack.questions, rank: pack.rank }, breaches: [CONFIRM_QUESTION, PASSAGE_QUESTION], judge: judge.name }));
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
    this.settling.clear();
    await this.store.set(KEY, []);
  }

  // verdicts still being settled off the hook's clock, by key, in this environment: the one in flight joined by a
  // call on the same text, and one settled without being kept (the judge failed) answered once to the call that
  // settles on it
  private readonly settling = new Map<string, Promise<Verdict>>();
  private readonly unkept = new Map<string, Verdict>();

  // work that settles the verdict for key; kept says whether it went to the store
  settle(key: string, work: Promise<{ verdict: Verdict; kept: boolean }>): Promise<Verdict> {
    const done = work.then(({ verdict, kept }) => {
      this.settling.delete(key);
      if (!kept) {
        this.unkept.set(key, verdict);
        for (const old of this.unkept.keys()) if (this.unkept.size > MAX_UNKEPT) this.unkept.delete(old);
      }
      return verdict;
    });
    done.catch(() => this.settling.delete(key));
    this.settling.set(key, done);
    return done;
  }

  // the settle in flight for key, or the verdict one settled without keeping, taken so a later call judges afresh
  inFlight(key: string): { running: Promise<Verdict> } | { settled: Verdict } | undefined {
    const running = this.settling.get(key);
    if (running) return { running };
    const settled = this.unkept.get(key);
    if (!settled) return undefined;
    this.unkept.delete(key);
    return { settled };
  }

  private async entries(): Promise<Entry[]> {
    const got = await this.store.get(KEY);
    return Array.isArray(got) ? (got as Entry[]) : [];
  }
}
