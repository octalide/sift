import { describe, expect, it } from 'vitest';
import { bandOf } from '../src/judge/bands.ts';
import { JevJudge, parseResponse } from '../src/judge/jev.ts';
import { LoggedJudge, type Decision } from '../src/judge/index.ts';
import { DecisionLog } from '../src/log.ts';
import { ModelJudge, extractJson } from '../src/judge/model.ts';
import { judgeLine, makeJudge, resolveApiKey } from '../src/judge/index.ts';
import { batchEntries, entryOf, fill, fillQuestion, rank, splitKey } from '../src/judge/rank.ts';
import { failureText, type Judge, type Questions } from '../src/judge/types.ts';

const questions: Questions = {
  yes: { type: 'noul', instructions: 'is it?' },
  pick: { type: 'choice', instructions: 'which?', criteria: { a: 'A', b: 'B' } },
  level: { type: 'score', instructions: 'how much?', criteria: ['low', 'high'] },
};

describe('jev response parsing', () => {
  it('normalizes every question type', () => {
    const body = JSON.stringify({
      answers: {
        yes: { type: 'noul', noul: 0.9 },
        pick: { type: 'choice', choice: 'b', probabilities: { a: 0.2, b: 0.8 }, confidence: 0.8 },
        level: { type: 'score', score: 0.9, legend: { '0': 'low', '1': 'high' }, probabilities: { '0': 0.1, '1': 0.9 }, confidence: 0.9 },
      },
    });
    const answers = parseResponse(body, questions);
    expect(typeof answers).toBe('object');
    if (typeof answers === 'string') throw new Error(answers);
    expect(answers['yes']).toEqual({ type: 'noul', p: 0.9 });
    expect(answers['pick']).toMatchObject({ type: 'choice', choice: 'b', confidence: 0.8 });
    expect(answers['level']).toEqual({ type: 'score', score: 1, expected: 0.9, legend: 'high', probabilities: [0.1, 0.9], confidence: 0.9 });
  });

  it('reads a score answer from an array and derives what is missing', () => {
    const body = JSON.stringify({ answers: { level: { score: 1, probabilities: [0.3, 0.7] } } });
    const answers = parseResponse(body, { level: questions['level']! });
    if (typeof answers === 'string') throw new Error(answers);
    expect(answers['level']).toEqual({ type: 'score', score: 1, expected: 1, legend: 'high', probabilities: [0.3, 0.7], confidence: 0.7 });
    expect(parseResponse(JSON.stringify({ answers: { level: { score: 1, probabilities: { '2': 1 } } } }), { level: questions['level']! })).toMatch(/level/);
  });

  it('reports a missing or misfit answer', () => {
    expect(parseResponse('{"answers":{}}', questions)).toMatch(/yes/);
    expect(parseResponse('nope', questions)).toMatch(/JSON/);
  });

  it('maps transport outcomes to failure reasons', async () => {
    const judge = (status: number, text = '{}') => new JevJudge({ apiKey: 'k', model: 'm', baseUrl: 'u' }, async () => ({ status, ok: status < 400, text }));
    expect((await judge(422).ask({}, questions)).ok).toBe(false);
    expect((await judge(422).ask({}, questions)) as { reason: string }).toMatchObject({ reason: 'rejected' });
    expect((await judge(529).ask({}, questions)) as { reason: string }).toMatchObject({ reason: 'unavailable' });
    expect((await judge(200, '{"answers":{}}').ask({}, questions)) as { reason: string }).toMatchObject({ reason: 'malformed' });
  });

  it('sends the documented request shape', async () => {
    let sent: { url: string; body: string } | undefined;
    const judge = new JevJudge({ apiKey: 'key', model: 'jev-x', baseUrl: 'https://x/y' }, async (url, init) => {
      sent = { url, body: init?.body ?? '' };
      return { status: 200, ok: true, text: JSON.stringify({ answers: { yes: { noul: 0.5 } } }) };
    });
    await judge.ask({ a: 1 }, { yes: questions['yes']! });
    expect(sent?.url).toBe('https://x/y');
    expect(JSON.parse(sent!.body)).toEqual({ model: 'jev-x', state: { a: 1 }, questions: { yes: questions['yes'] } });
  });
});

describe('usage accounting', () => {
  it('takes the backend count when reported and estimates otherwise, on success and failure', async () => {
    const withUsage = new JevJudge({ apiKey: 'k', model: 'm', baseUrl: 'u' }, async () => ({ status: 200, ok: true, text: JSON.stringify({ answers: { yes: { noul: 0.5 } }, usage: { input_tokens: 123, output_tokens: 7 } }) }));
    const r1 = await withUsage.ask({ a: 1 }, { yes: questions['yes']! });
    expect(r1.usage).toEqual({ requestTokens: 123, responseTokens: 7, source: 'backend' });
    const estimated = new JevJudge({ apiKey: 'k', model: 'm', baseUrl: 'u' }, async () => ({ status: 200, ok: true, text: JSON.stringify({ answers: { yes: { noul: 0.5 } } }) }));
    const r2 = await estimated.ask({ a: 'x'.repeat(600) }, { yes: questions['yes']! });
    expect(r2.usage?.source).toBe('estimate');
    expect(r2.usage!.requestTokens).toBeGreaterThan(100);
    const failed = new JevJudge({ apiKey: 'k', model: 'm', baseUrl: 'u' }, async () => ({ status: 400, ok: false, text: 'too big' }));
    const r3 = await failed.ask({ a: 1 }, { yes: questions['yes']! });
    expect(r3.ok).toBe(false);
    expect(r3.usage?.requestTokens).toBeGreaterThan(0);
    const model = new ModelJudge('haiku', async () => '{"yes":{"noul":0.2}}');
    const r4 = await model.ask({}, { yes: questions['yes']! });
    expect(r4.usage).toMatchObject({ source: 'estimate' });
    expect(r4.usage!.requestTokens).toBeGreaterThan(50);
  });

  it('records the cost on the decision and sums it per module and per session', async () => {
    const decisions: Decision[] = [];
    const logged = new LoggedJudge(new ModelJudge('haiku', async () => '{"yes":{"noul":0.2}}'), (d) => decisions.push({ ...d, module: 'judge', action: 'ask', shadow: false }));
    await logged.ask({}, { yes: questions['yes']! });
    expect(decisions[0]!.requestTokens).toBeGreaterThan(0);
    expect(decisions[0]!.responseTokens).toBeGreaterThan(0);
    const store = new Map<string, unknown>();
    const log = new DecisionLog({ get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) }, 's');
    log.push(decisions[0]!);
    log.push({ at: 1, module: 'prune', backend: 'x', ok: true, digest: '', action: 'pruned', shadow: false, tokensRemoved: 500 });
    log.push({ at: 1, module: 'prune', backend: 'x', ok: true, digest: '', action: 'would-prune', shadow: true, tokensRemoved: 9000 });
    const stats = await log.stats();
    expect(stats.session.cost).toEqual({ requestTokens: decisions[0]!.requestTokens, responseTokens: decisions[0]!.responseTokens, tokensRemoved: 500 });
    expect(stats.byModule['prune']!.tokensRemoved).toBe(500);
  });
});

describe('model backend', () => {
  it('extracts JSON from a chatty reply and widens choice and score answers', async () => {
    const judge = new ModelJudge('haiku', async () => 'Sure: {"yes":{"noul":0.2},"pick":{"choice":"a","confidence":0.7},"level":{"score":0,"confidence":0.6}} done');
    const r = await judge.ask({}, questions);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers['pick']).toMatchObject({ choice: 'a', probabilities: { a: 0.7, b: expect.closeTo(0.3, 5) } });
    expect(r.answers['level']).toMatchObject({ score: 0, legend: 'low', confidence: 0.6 });
  });

  it('fails as malformed when the reply holds no object', async () => {
    const judge = new ModelJudge('haiku', async () => 'I cannot answer.');
    expect(await judge.ask({}, questions)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(extractJson('x')).toBeUndefined();
  });
});

describe('backend selection', () => {
  const host = { fetch: async () => ({ status: 200, ok: true, text: '' }), complete: async () => '' };
  it('prefers jev when a key exists under auto and falls back to the model otherwise', () => {
    expect(makeJudge({ backend: 'auto', apiKey: 'k', jevModel: 'm', jevBaseUrl: 'u', fallbackModel: 'haiku' }, host).name).toBe('jev');
    expect(makeJudge({ backend: 'auto', jevModel: 'm', jevBaseUrl: 'u', fallbackModel: 'haiku' }, host).name).toBe('model:haiku');
    expect(makeJudge({ backend: 'jev', jevModel: 'm', jevBaseUrl: 'u', fallbackModel: 'haiku' }, host).name).toBe('off');
    expect(makeJudge({ backend: 'off', apiKey: 'k', jevModel: 'm', jevBaseUrl: 'u', fallbackModel: 'haiku' }, host).name).toBe('off');
  });
});

describe('api key source', () => {
  const none = { env: async () => undefined, settings: async () => ({}) };
  it('takes the option, then the environment, then the settings env block', async () => {
    expect(await resolveApiKey({ ...none, option: 'opt-1234', env: async () => 'env-5678' })).toEqual({ key: 'opt-1234', source: 'option' });
    expect(await resolveApiKey({ ...none, env: async () => 'env-5678', settings: async () => ({ env: { TYPESAFE_API_KEY: 'set-9012' } }) })).toEqual({ key: 'env-5678', source: 'env' });
    expect(await resolveApiKey({ ...none, settings: async () => ({ env: { TYPESAFE_API_KEY: 'set-9012' } }) })).toEqual({ key: 'set-9012', source: 'settings' });
    expect(await resolveApiKey(none)).toBeUndefined();
  });

  it('names the source on an authentication failure and nowhere else', async () => {
    const jev = (status: number) =>
      makeJudge(
        { backend: 'jev', apiKey: 'stale-key-abcd', keySource: 'option', jevModel: 'm', jevBaseUrl: 'u', fallbackModel: 'haiku' },
        { fetch: async () => ({ status, ok: false, text: 'Please check your API key' }), complete: async () => '' },
      );
    for (const status of [401, 403]) {
      const result = await jev(status).ask({}, questions);
      expect(result).toMatchObject({ ok: false, reason: 'unavailable', status, keySource: 'option' });
      if (result.ok) throw new Error('expected a failure');
      expect(failureText(result)).toBe(`unavailable (key from the apiKey option): http ${status}: Please check your API key`);
      expect(failureText(result)).not.toContain('stale-key');
    }
    const down = await jev(529).ask({}, questions);
    if (down.ok) throw new Error('expected a failure');
    expect(down.keySource).toBeUndefined();
    expect(failureText(down)).toBe('unavailable: http 529: Please check your API key');
  });

  it('carries the source through a rank failure', async () => {
    const judge = makeJudge(
      { backend: 'jev', apiKey: 'k', keySource: 'settings', jevModel: 'm', jevBaseUrl: 'u', fallbackModel: 'haiku' },
      { fetch: async () => ({ status: 401, ok: false, text: 'no' }), complete: async () => '' },
    );
    const result = await rank(['x'], { yes: questions['yes']! }, judge, { mode: 'batched' });
    if (result.ok) throw new Error('expected a failure');
    expect(failureText(result)).toBe('unavailable (key from TYPESAFE_API_KEY in the settings env block): http 401: no');
  });

  it('shows the backend and, for jev, the key source and last four characters only', () => {
    const key = 'sk-secret-material-wxyz';
    expect(judgeLine('jev', { key, source: 'option' })).toBe('judge: jev, key from the apiKey option (ending wxyz)');
    expect(judgeLine('jev', { key, source: 'env' })).toBe('judge: jev, key from TYPESAFE_API_KEY in the environment (ending wxyz)');
    expect(judgeLine('jev', { key, source: 'settings' })).toBe('judge: jev, key from TYPESAFE_API_KEY in the settings env block (ending wxyz)');
    expect(judgeLine('jev', { key, source: 'env' })).not.toContain('secret');
    expect(judgeLine('model:haiku', { key, source: 'env' })).toBe('judge: model:haiku');
    expect(judgeLine('off')).toBe('judge: off');
  });
});

describe('bands', () => {
  it('bands on probability for noul and confidence otherwise', () => {
    expect(bandOf({ type: 'noul', p: 0.9 })).toBe('satisfied');
    expect(bandOf({ type: 'noul', p: 0.5 })).toBe('unclear');
    expect(bandOf({ type: 'noul', p: 0.1 })).toBe('violated');
    expect(bandOf({ type: 'choice', choice: 'a', probabilities: {}, confidence: 0.2 }, { lo: 0.3, hi: 0.7 })).toBe('violated');
  });
});

describe('rank', () => {
  const needed: Questions = { needed: { type: 'noul', instructions: 'item {k} ({text}) is needed', criteria: { true: 'yes {label}', false: 'no' } } };
  type Ask = { state: Record<string, unknown>; questions: Questions };

  // answers every noul from the item text ("0.7") and records each request
  function recording(asks: Ask[], inFlight?: { now: number; max: number }): Judge {
    return {
      name: 'fake',
      ask: async (state, questions) => {
        asks.push({ state: state as Record<string, unknown>, questions });
        if (inFlight) {
          inFlight.now += 1;
          inFlight.max = Math.max(inFlight.max, inFlight.now);
          await Promise.resolve();
          inFlight.now -= 1;
        }
        const answers = Object.fromEntries(
          Object.entries(questions).map(([k, q]) => [k, { type: 'noul' as const, p: Number(/\((\S+)\)/.exec(q.instructions)?.[1] ?? 0) }]),
        );
        return { ok: true, backend: 'fake', latencyMs: 1, answers, usage: { requestTokens: 10, responseTokens: 1, source: 'backend' as const } };
      },
    };
  }

  it('fills placeholders from the entry and leaves the rest as written', () => {
    expect(entryOf('hello', 3)).toEqual({ k: 3, text: 'hello' });
    expect(entryOf({ k: 9, text: 'a', n: 2 }, 0)).toEqual({ k: 0, text: 'a', n: 2 });
    expect(fill('{k}: {text} {n} {subject} {missing}', { k: 1, text: 't', n: 2, nested: {} })).toBe('1: t 2 {subject} {missing}');
    const q = fillQuestion(needed['needed']!, { k: 2, text: '0.5', label: 'L' });
    expect(q.instructions).toBe('item 2 (0.5) is needed');
    expect(q).toMatchObject({ criteria: { true: 'yes L', false: 'no' } });
    expect(splitKey('needed_12')).toEqual({ id: 'needed', index: 12 });
    expect(splitKey('a_b_3')).toEqual({ id: 'a_b', index: 3 });
    expect(splitKey('plain')).toBeUndefined();
  });

  it('batched: one state holds every item, keys carry the index, answers come back in input order and sorted', async () => {
    const asks: Ask[] = [];
    const result = await rank(['0.2', '0.9', '0.5'], needed, recording(asks), { mode: 'batched', context: { task: 'x' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(asks).toHaveLength(1);
    expect(asks[0]!.state).toEqual({ task: 'x', items: [{ k: 0, text: '0.2' }, { k: 1, text: '0.9' }, { k: 2, text: '0.5' }] });
    expect(Object.keys(asks[0]!.questions)).toEqual(['needed_0', 'needed_1', 'needed_2']);
    expect(asks[0]!.questions['needed_1']!.instructions).toBe('item 1 (0.9) is needed');
    expect(result.items.map((r) => [r.index, r.item, r.value])).toEqual([[0, '0.2', 0.2], [1, '0.9', 0.9], [2, '0.5', 0.5]]);
    expect(result.items[0]!.answers).toEqual({ needed: { type: 'noul', p: 0.2 } });
    expect(result.sorted.map((r) => r.index)).toEqual([1, 2, 0]);
    expect(result.requests).toBe(1);
    expect(result.usage).toEqual({ requestTokens: 10, responseTokens: 1, source: 'backend' });
  });

  it('batched: splits items across requests when the state or the request would pass its budget', async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ text: `0.${i % 10}`, pad: 'x'.repeat(400) }));
    const entries = items.map((item, i) => entryOf(item, i));
    const byState = batchEntries(entries, needed, {}, 600, 100_000);
    expect(byState.length).toBeGreaterThan(1);
    expect(byState.flat().map((e) => e.k)).toEqual(items.map((_, i) => i));
    const byRequest = batchEntries(entries, needed, {}, 100_000, 800);
    expect(byRequest.length).toBeGreaterThan(byState.length);
    expect(batchEntries(entries.slice(0, 1), needed, {}, 10, 10)).toHaveLength(1);
    const asks: Ask[] = [];
    const result = await rank(items, needed, recording(asks), { mode: 'batched', maxStateTokens: 600 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(asks.length).toBe(byState.length);
    expect(result.requests).toBe(asks.length);
    expect(result.items.map((r) => r.value)).toEqual(items.map((_, i) => (i % 10) / 10));
    expect(result.sorted[0]!.value).toBe(0.9);
  });

  it('isolated: one request per item with the item alone in the state, run concurrently under the limit', async () => {
    const asks: Ask[] = [];
    const inFlight = { now: 0, max: 0 };
    const items = Array.from({ length: 10 }, (_, i) => ({ text: `0.${i}`, label: `L${i}` }));
    const result = await rank(items, needed, recording(asks, inFlight), { mode: 'isolated', context: { task: 'x' }, concurrency: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(asks).toHaveLength(10);
    expect(asks.map((a) => a.state)).toContainEqual({ task: 'x', item: { k: 4, text: '0.4', label: 'L4' } });
    expect(Object.keys(asks[0]!.questions)).toEqual(['needed']);
    expect(inFlight.max).toBe(3);
    expect(result.items.map((r) => r.item)).toEqual(items);
    expect(result.items.map((r) => r.value)).toEqual(items.map((_, i) => i / 10));
    expect(result.sorted.map((r) => r.index)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('sorts by a named question, a choice key, and rejects an unknown one', async () => {
    const both: Questions = {
      needed: needed['needed']!,
      kind: { type: 'choice', instructions: 'which', criteria: { a: 'A', b: 'B' } },
    };
    const judge: Judge = {
      name: 'fake',
      ask: async (_s, questions) => ({
        ok: true,
        backend: 'fake',
        latencyMs: 1,
        answers: Object.fromEntries(
          Object.entries(questions).map(([k, q]) => {
            const index = Number(k.split('_').pop());
            return q.type === 'noul'
              ? [k, { type: 'noul' as const, p: index / 10 }]
              : [k, { type: 'choice' as const, choice: 'a', probabilities: { a: 1 - index / 10, b: index / 10 }, confidence: 1 - index / 10 }];
          }),
        ),
      }),
    };
    const byChoice = await rank(['x', 'y', 'z'], both, judge, { mode: 'batched', by: 'kind', choice: 'b' });
    if (!byChoice.ok) throw new Error(byChoice.message);
    expect(byChoice.sorted.map((r) => r.index)).toEqual([2, 1, 0]);
    const byConfidence = await rank(['x', 'y', 'z'], both, judge, { mode: 'batched', by: 'kind' });
    if (!byConfidence.ok) throw new Error(byConfidence.message);
    expect(byConfidence.sorted.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(await rank(['x'], both, judge, { mode: 'batched', by: 'nope' })).toMatchObject({ ok: false, reason: 'rejected' });
    expect(await rank(['x'], {}, judge, { mode: 'batched' })).toMatchObject({ ok: false, reason: 'rejected' });
    const empty = await rank([], both, judge, { mode: 'isolated' });
    expect(empty).toMatchObject({ ok: true, items: [], sorted: [], requests: 0 });
  });

  it('drops an answer under a key no item or question owns and counts it', async () => {
    const extra: Judge = {
      name: 'fake',
      ask: async (_state, questions) => ({
        ok: true,
        backend: 'fake',
        latencyMs: 1,
        answers: {
          ...Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, p: 0.5 }])),
          needed_7: { type: 'noul' as const, p: 0.9 },
          other_0: { type: 'noul' as const, p: 0.9 },
          plain: { type: 'noul' as const, p: 0.9 },
        },
      }),
    };
    const result = await rank(['a', 'b'], needed, extra, { mode: 'batched' });
    if (!result.ok) throw new Error(result.message);
    expect(result.items.map((r) => r.answers)).toEqual([{ needed: { type: 'noul', p: 0.5 } }, { needed: { type: 'noul', p: 0.5 } }]);
    expect(result.dropped).toBe(3);
    const isolated = await rank(['a'], needed, extra, { mode: 'isolated' });
    if (!isolated.ok) throw new Error(isolated.message);
    expect(isolated.items[0]!.answers).toEqual({ needed: { type: 'noul', p: 0.5 } });
    expect(isolated.dropped).toBe(3);
  });

  it('fails as a whole when any request fails', async () => {
    let calls = 0;
    const flaky: Judge = {
      name: 'fake',
      ask: async () => (++calls === 2 ? { ok: false, reason: 'unavailable', message: 'down', backend: 'fake' } : { ok: true, backend: 'fake', latencyMs: 1, answers: { needed: { type: 'noul', p: 1 } } }),
    };
    const result = await rank(['a', 'b', 'c'], needed, flaky, { mode: 'isolated' });
    expect(result).toMatchObject({ ok: false, reason: 'unavailable', message: 'down', requests: 3 });
  });
});
