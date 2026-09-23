import { describe, expect, it } from 'vitest';
import { ownerOf, rulesKeys, STALE_MS, StoreKeys, watchKeys } from '../src/keys.ts';
import { memoryStore } from './fake-source.ts';

const D = 24 * 3600 * 1000;

// every key a session with a subscription on o/r and o/s leaves
const keysOf = (session: string, seen?: number): [string, unknown][] => {
  const k = watchKeys(session);
  return [[k.subs, { next: 2, subs: [] }], [k.mail, []], [k.state('o/r'), { version: 9 }], [k.state('o/s'), { version: 9 }], ...(seen === undefined ? [] : ([[k.seen, seen]] as [string, unknown][]))];
};

// a rules cache for one scope, read at seen
const rulesOf = (scope: string, seen?: number): [string, unknown][] => {
  const k = rulesKeys(scope);
  return [[k.cache, { version: 1, rules: [] }], ...(seen === undefined ? [] : ([[k.seen, seen]] as [string, unknown][]))];
};

function harness(entries: [string, unknown][], clock = { now: 100 * D }) {
  const store = memoryStore(new Map(entries));
  const logs: string[] = [];
  return { sessions: new StoreKeys({ store, now: () => clock.now, log: (t) => void logs.push(t) }), store, logs, clock };
}

describe('watch session keys', () => {
  it('names the session each key belongs to and marks the pre-session keys', () => {
    const k = watchKeys('abc-1');
    const session = { kind: 'session', id: 'abc-1' };
    expect([k.subs, k.mail, k.seen, k.state('o/r')].map(ownerOf)).toEqual([session, session, session, session]);
    expect(ownerOf('watch:o/r')).toBe('legacy');
    expect(ownerOf('decisions')).toBeUndefined();
    const r = rulesKeys('o/r@dev');
    expect([r.cache, r.seen].map(ownerOf)).toEqual([{ kind: 'rules', id: 'o/r@dev' }, { kind: 'rules', id: 'o/r@dev' }]);
    expect(ownerOf(rulesKeys('/home/me/repo').cache)).toEqual({ kind: 'rules', id: '/home/me/repo' });
  });

  it('removes every key of an ended session and none of another\'s', async () => {
    const { sessions, store } = harness([...keysOf('a', 1), ...keysOf('b', 1), ['decisions', []], ['watch:o/r', {}], ...rulesOf('a', 1)]);
    await sessions.end('a');
    expect([...store.map.keys()].sort()).toEqual(['decisions', 'rules-seen:a', 'rules:a', 'watch-mail:b', 'watch-seen:b', 'watch-subs:b', 'watch:b:o/r', 'watch:b:o/s', 'watch:o/r']);
  });

  it('sweeps the pre-session keys and stale sessions at start, keeping the fresh and the current', async () => {
    const now = 100 * D;
    const { sessions, store, logs } = harness([
      ['watch:o/r', { version: 8 }],
      ['watch:o/other', { version: 8 }],
      ...keysOf('stale', now - STALE_MS - 1),
      ...keysOf('fresh', now - STALE_MS + D),
      ...keysOf('unmarked'),
      ...keysOf('me', now - 30 * D),
      ['decisions', []],
    ]);
    await sessions.sweep('me');
    const left = [...store.map.keys()];
    expect(left.filter((k) => ownerOf(k) === 'legacy')).toEqual([]);
    expect(left.filter((k) => k.includes('stale'))).toEqual([]);
    expect(left.filter((k) => k.includes('fresh'))).toHaveLength(5);
    expect(left.filter((k) => k.includes(':me'))).toHaveLength(5);
    expect(left).toContain('decisions');
    // a session written before sessions were marked is marked now, and goes stale from here
    expect(store.map.get(watchKeys('unmarked').seen)).toBe(now);
    expect(left.filter((k) => k.includes('unmarked'))).toHaveLength(5);
    expect(logs).toEqual(['sift: removed 2 pre-session keys, the keys of 1 stale session and 0 unused rules caches']);
  });

  it('removes an unmarked session once it has gone unseen for the stale window', async () => {
    const { sessions, store, clock } = harness(keysOf('old'));
    await sessions.sweep('me');
    clock.now += STALE_MS - 1;
    await sessions.sweep('me');
    expect([...store.map.keys()].filter((k) => k.includes('old'))).toHaveLength(5);
    clock.now += 1;
    await sessions.sweep('me');
    expect([...store.map.keys()]).toEqual([]);
  });

  it('keeps a session that marks itself seen while it runs', async () => {
    const { sessions, store, clock } = harness([]);
    for (const [k, v] of keysOf('live')) store.map.set(k, v);
    await sessions.touch('live');
    clock.now += STALE_MS - 1;
    await sessions.touch('live');
    clock.now += STALE_MS - 1;
    await sessions.sweep('me');
    expect([...store.map.keys()].filter((k) => k.includes('live'))).toHaveLength(5);
  });
});

describe('rules cache keys', () => {
  it('sweeps a scope unread for the stale window and keeps a fresh one, whichever session reads it', async () => {
    const now = 100 * D;
    const { sessions, store, logs } = harness([...rulesOf('/gone', now - STALE_MS - 1), ...rulesOf('o/r@dev', now - STALE_MS + D), ...rulesOf('/old'), ...keysOf('me', now)]);
    await sessions.sweep('me');
    const left = [...store.map.keys()];
    expect(left.filter((k) => k.includes('/gone'))).toEqual([]);
    expect(left.filter((k) => k.includes('o/r@dev'))).toHaveLength(2);
    // a cache written before scopes were marked is marked now, and goes stale from here
    expect(store.map.get(rulesKeys('/old').seen)).toBe(now);
    expect(logs).toEqual(['sift: removed 0 pre-session keys, the keys of 0 stale sessions and 1 unused rules cache']);
  });

  it('removes an unmarked cache once it has gone unread for the stale window', async () => {
    const { sessions, store, clock } = harness(rulesOf('/old'));
    await sessions.sweep('me');
    clock.now += STALE_MS - 1;
    await sessions.sweep('me');
    expect([...store.map.keys()]).toEqual([rulesKeys('/old').cache, rulesKeys('/old').seen]);
    clock.now += 1;
    await sessions.sweep('me');
    expect([...store.map.keys()]).toEqual([]);
  });
});
