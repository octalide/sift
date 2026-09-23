import { describe, expect, it } from 'vitest';
import { Spawns } from '../src/spawns.ts';
import { Tenure, tenureToken } from '../src/tenure.ts';
import { memoryStore } from './fake-source.ts';

// timers that run when the test says so
function clock() {
  const due: (() => void)[] = [];
  const fire = async () => {
    for (const fn of due.splice(0)) fn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { after: (_ms: number, fn: () => void) => (due.push(fn), { cancel: () => {} }), fire };
}

describe('reload tenure', () => {
  it('stands the replaced environment down: its timers run nothing and its writes are dropped', async () => {
    const store = memoryStore();
    const timers = clock();
    let lost = 0;
    const old = new Tenure({ store, key: 'tenure:s', token: 'a', after: timers.after, lost: () => void lost++ });
    await old.claim();
    const oldStore = old.store(store);
    await oldStore.set('watch-subs:s', { next: 1 });
    const ran: string[] = [];
    old.after(10, () => void ran.push('old'));
    await timers.fire();
    expect(ran).toEqual(['old']);

    const fresh = new Tenure({ store, key: 'tenure:s', token: 'b', after: timers.after, lost: () => {} });
    await fresh.claim();
    await fresh.store(store).set('watch-subs:s', { next: 5 });
    old.after(10, () => void ran.push('old'));
    fresh.after(10, () => void ran.push('new'));
    await timers.fire();
    await oldStore.set('watch-subs:s', { next: 2 });
    expect(ran).toEqual(['old', 'new']);
    expect(store.map.get('watch-subs:s')).toEqual({ next: 5 });
    expect(await old.holds()).toBe(false);
    expect(await fresh.holds()).toBe(true);
    expect(lost).toBe(1);
  });

  it('draws a distinct token per environment', () => {
    expect(tenureToken(5, () => 0.25)).toBe('5-9');
    expect(tenureToken(5, () => 0.5)).not.toBe(tenureToken(5, () => 0.25));
  });
});

describe('spawn records', () => {
  it('knows which tools a subagent was spawned with, and the main loop has them all', async () => {
    const spawns = new Spawns();
    await spawns.spawned('early', '/w', undefined, ['mcp__sift__grade']);
    await spawns.spawned('late', undefined, 'early', ['mcp__sift__grade', 'mcp__sift__post']);
    expect(spawns.has(undefined, 'mcp__sift__post')).toBe(true);
    expect(spawns.has('early', 'mcp__sift__post')).toBe(false);
    expect(spawns.has('late', 'mcp__sift__post')).toBe(true);
    expect(spawns.has('unknown', 'mcp__sift__post')).toBe(false);
    expect(spawns.of('late')).toBe('/w');
  });

  it('keeps what an earlier environment recorded across a reload', async () => {
    const store = memoryStore();
    const before = new Spawns();
    await before.bind(store, 'agents:s');
    await before.spawned('early', '/w', undefined, ['mcp__sift__grade']);

    // the new environment records a spawn before its session start binds it
    const after = new Spawns();
    await after.spawned('late', '/v', undefined, ['mcp__sift__post']);
    await after.bind(store, 'agents:s');
    expect(after.of('early')).toBe('/w');
    expect(after.has('early', 'mcp__sift__grade')).toBe(true);
    expect(after.has('late', 'mcp__sift__post')).toBe(true);
    expect(Object.keys(store.map.get('agents:s') as object).sort()).toEqual(['early', 'late']);
  });
});
