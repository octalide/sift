import type { StoreLike } from '../log.ts';

// the engine's store with the calls that remove what a session left
export type KeyStore = StoreLike & {
  delete: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
};

// a session unseen this long is gone: its keys are removed at the next start of any session
export const STALE_MS = 7 * 24 * 3600 * 1000;

// how often a running session marks itself seen, far inside STALE_MS so a live session is never swept
export const SEEN_EVERY_MS = 3600 * 1000;

// every key the watch writes for one session. seen is the session's own, so no two sessions write one key
export const watchKeys = (session: string) => ({
  subs: `watch-subs:${session}`,
  mail: `watch-mail:${session}`,
  seen: `watch-seen:${session}`,
  state: (repo: string) => `watch:${session}:${repo}`,
});

// the session a watch key belongs to, legacy for a pre-session `watch:<repo>`, undefined for a key not the watch's
export function ownerOf(key: string): { session: string } | 'legacy' | undefined {
  for (const prefix of ['watch-subs:', 'watch-mail:', 'watch-seen:']) {
    if (key.startsWith(prefix)) return { session: key.slice(prefix.length) };
  }
  if (!key.startsWith('watch:')) return undefined;
  const rest = key.slice('watch:'.length);
  const colon = rest.indexOf(':');
  return colon < 0 ? 'legacy' : { session: rest.slice(0, colon) };
}

export type SessionsHost = {
  store: KeyStore;
  now: () => number;
  log: (text: string) => void;
};

// the lifetime of each session's watch keys: marked seen while it runs, removed when it ends or goes stale
export class Sessions {
  constructor(private readonly host: SessionsHost) {}

  async touch(session: string): Promise<void> {
    await this.host.store.set(watchKeys(session).seen, this.host.now());
  }

  // removes the pre-session keys and every other session's unseen for STALE_MS. a session with keys but no seen mark
  // (written before sessions were marked) is marked now, so it goes stale from here
  async sweep(current: string): Promise<void> {
    const bySession = new Map<string, string[]>();
    const legacy: string[] = [];
    for (const key of await this.host.store.keys()) {
      const owner = ownerOf(key);
      if (owner === undefined) continue;
      if (owner === 'legacy') legacy.push(key);
      else if (owner.session !== current) bySession.set(owner.session, [...(bySession.get(owner.session) ?? []), key]);
    }
    for (const key of legacy) await this.host.store.delete(key);
    const now = this.host.now();
    let stale = 0;
    for (const [session, keys] of bySession) {
      const seen = await this.host.store.get(watchKeys(session).seen);
      if (typeof seen !== 'number') {
        await this.host.store.set(watchKeys(session).seen, now);
        continue;
      }
      if (now - seen < STALE_MS) continue;
      for (const key of keys) await this.host.store.delete(key);
      stale += 1;
    }
    if (legacy.length > 0 || stale > 0) this.host.log(`sift watch: removed ${legacy.length} pre-session key${legacy.length === 1 ? '' : 's'} and the keys of ${stale} stale session${stale === 1 ? '' : 's'}`);
  }

  // every key the session wrote
  async end(session: string): Promise<void> {
    for (const key of await this.host.store.keys()) {
      const owner = ownerOf(key);
      if (owner !== undefined && owner !== 'legacy' && owner.session === session) await this.host.store.delete(key);
    }
  }
}
