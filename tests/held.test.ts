import { describe, expect, it } from 'vitest';
import { HeldPosts } from '../src/gate/held.ts';
import { memoryStore } from './fake-source.ts';

// two environments of one session over one store, the tenure moving to the second when it starts
function session() {
  const store = memoryStore();
  let owner = 1;
  let ids = 0;
  const env = (n: number) => new HeldPosts({ store, key: 'held:s', holds: async () => owner === n, now: () => 5, id: () => `h${++ids}` });
  return { store, env, reload: (n: number) => void (owner = n) };
}

describe('held posts', () => {
  it('lets the environment that held a post claim it once, and makes it only there', async () => {
    const { env, store } = session();
    const first = env(1);
    const id = await first.keep('a1', { repo: 'o/r', kind: 'pr-comment', number: 4, body: 'hi' });
    expect(store.map.get('held:s')).toEqual([{ id, to: 'a1', input: { repo: 'o/r', kind: 'pr-comment', number: 4, body: 'hi' }, at: 5 }]);
    expect(await first.claim(id)).toBe(true);
    expect(await first.claim(id)).toBe(false);
    expect(store.map.get('held:s')).toEqual([]);
  });

  it('hands a post held across a reload to the environment that replaced the one that held it', async () => {
    const { env, reload } = session();
    const first = env(1);
    const id = await first.keep(undefined, { repo: 'o/r', kind: 'issue-create', title: 't', body: 'b' });
    reload(2);
    const second = env(2);
    expect(await second.takeOver()).toEqual([{ id, input: { repo: 'o/r', kind: 'issue-create', title: 't', body: 'b' }, at: 5 }]);
    // the replaced environment's claim fails, so the post is made once, by the environment that took it over
    expect(await first.claim(id)).toBe(false);
    expect(await second.takeOver()).toEqual([]);
  });

  it('refuses to hold a post in an environment a reload already replaced, rather than drop it', async () => {
    const { env, reload, store } = session();
    const first = env(1);
    reload(2);
    await expect(first.keep('a1', { repo: 'o/r', kind: 'pr-comment', number: 4, body: 'hi' })).rejects.toThrow('a reload replaced this sift environment while the post was made, so it was not held and nothing was written. Make the post again');
    expect(store.map.get('held:s')).toBeUndefined();
  });
});
