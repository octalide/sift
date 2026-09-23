import type { StoreLike } from './log.ts';

// the engine's store with the calls that remove what an owner left
export type KeyStore = StoreLike & {
  delete: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
};

// an owner unseen this long is gone: its keys are removed at the next start of any session
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

// every key rule discovery writes for one scope: the cache every session shares, and when a discovery last read it
export const rulesKeys = (scope: string) => ({
  cache: `rules:${scope}`,
  seen: `rules-seen:${scope}`,
});

// what writes a key: a session's watch, or the rules cache of one scope
export type Owner = { kind: 'session' | 'rules'; id: string };

const PREFIXES: [string, Owner['kind']][] = [
  ['watch-subs:', 'session'],
  ['watch-mail:', 'session'],
  ['watch-seen:', 'session'],
  ['rules:', 'rules'],
  ['rules-seen:', 'rules'],
];

// the owner of a key, legacy for a pre-session `watch:<repo>`, undefined for a key no owner's
export function ownerOf(key: string): Owner | 'legacy' | undefined {
  for (const [prefix, kind] of PREFIXES) {
    if (key.startsWith(prefix)) return { kind, id: key.slice(prefix.length) };
  }
  if (!key.startsWith('watch:')) return undefined;
  const rest = key.slice('watch:'.length);
  const colon = rest.indexOf(':');
  return colon < 0 ? 'legacy' : { kind: 'session', id: rest.slice(0, colon) };
}

const seenOf = (owner: Owner): string => (owner.kind === 'session' ? watchKeys(owner.id).seen : rulesKeys(owner.id).seen);

export type StoreKeysHost = {
  store: KeyStore;
  now: () => number;
  log: (text: string) => void;
};

// the lifetime of every owner's keys: marked seen while in use, a session's removed when it ends, any owner's once stale
export class StoreKeys {
  constructor(private readonly host: StoreKeysHost) {}

  async touch(session: string): Promise<void> {
    await this.host.store.set(watchKeys(session).seen, this.host.now());
  }

  // removes the pre-session keys and every owner's but the current session's unseen for STALE_MS. an owner with keys
  // but no seen mark (written before it was marked) is marked now, so it goes stale from here
  async sweep(current: string): Promise<void> {
    const byOwner = new Map<string, { owner: Owner; keys: string[] }>();
    const legacy: string[] = [];
    for (const key of await this.host.store.keys()) {
      const owner = ownerOf(key);
      if (owner === undefined) continue;
      if (owner === 'legacy') {
        legacy.push(key);
        continue;
      }
      if (owner.kind === 'session' && owner.id === current) continue;
      const id = `${owner.kind}\0${owner.id}`;
      const group = byOwner.get(id) ?? { owner, keys: [] };
      group.keys.push(key);
      byOwner.set(id, group);
    }
    for (const key of legacy) await this.host.store.delete(key);
    const now = this.host.now();
    const stale = { session: 0, rules: 0 };
    for (const { owner, keys } of byOwner.values()) {
      const seen = await this.host.store.get(seenOf(owner));
      if (typeof seen !== 'number') {
        await this.host.store.set(seenOf(owner), now);
        continue;
      }
      if (now - seen < STALE_MS) continue;
      for (const key of keys) await this.host.store.delete(key);
      stale[owner.kind] += 1;
    }
    if (legacy.length > 0 || stale.session > 0 || stale.rules > 0) {
      const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
      this.host.log(`sift: removed ${n(legacy.length, 'pre-session key')}, the keys of ${n(stale.session, 'stale session')} and ${n(stale.rules, 'unused rules cache')}`);
    }
  }

  // every key the session wrote. a rules cache is every session's, so it stays
  async end(session: string): Promise<void> {
    for (const key of await this.host.store.keys()) {
      const owner = ownerOf(key);
      if (owner !== undefined && owner !== 'legacy' && owner.kind === 'session' && owner.id === session) await this.host.store.delete(key);
    }
  }
}
