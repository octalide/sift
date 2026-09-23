import type { StoreLike } from './log.ts';

export type Timer = { cancel: () => void };

export type TenureHost = {
  store: StoreLike;
  // the session's tenure key
  key: string;
  // this environment's own mark, unique across every environment the session loads
  token: string;
  // runs fn once after ms
  after: (ms: number, fn: () => void) => Timer;
  // called once, when another environment is found to hold the session
  lost: () => void;
};

// which plugin environment owns a session's background work. a reload starts a new environment while the old one
// lives on until its last dispatch settles, its timers still running on the state it loaded. each environment claims
// the session at start, and the one whose claim was overwritten stands down: its timers run nothing and its writes
// are dropped, so it never moves or clobbers what the new one loaded
export class Tenure {
  private held = true;

  constructor(private readonly host: TenureHost) {}

  async claim(): Promise<void> {
    await this.host.store.set(this.host.key, this.host.token);
  }

  // false for good once another environment has claimed the session
  async holds(): Promise<boolean> {
    if (!this.held) return false;
    if ((await this.host.store.get(this.host.key)) === this.host.token) return true;
    this.held = false;
    this.host.lost();
    return false;
  }

  // the store as background work writes it: reads pass, a write from an environment that lost the session is dropped
  store<S extends StoreLike>(inner: S): S {
    return {
      ...inner,
      set: async (key: string, value: unknown) => {
        if (await this.holds()) await inner.set(key, value);
      },
    };
  }

  // a timer whose fn runs only while this environment holds the session
  after(ms: number, fn: () => void | Promise<void>): Timer {
    return this.host.after(ms, () => void this.holds().then((held) => (held ? fn() : undefined)));
  }
}

// a mark no other environment draws: the time it started and a random tail
export function tenureToken(now: number, random: () => number = Math.random): string {
  return `${now.toString(36)}-${random().toString(36).slice(2)}`;
}
