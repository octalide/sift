import { describe, expect, it } from 'vitest';
import { bandOf } from '../src/judge/bands.ts';
import { JevJudge, parseResponse } from '../src/judge/jev.ts';
import { LoggedJudge, type Decision } from '../src/judge/index.ts';
import { DecisionLog } from '../src/log.ts';
import { ModelJudge, extractJson } from '../src/judge/model.ts';
import { makeJudge } from '../src/judge/index.ts';
import type { Questions } from '../src/judge/types.ts';

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
    log.push({ at: 1, module: 'compact', backend: 'x', ok: true, digest: '', action: 'would-compact', shadow: true, tokensRemoved: 9000 });
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

describe('bands', () => {
  it('bands on probability for noul and confidence otherwise', () => {
    expect(bandOf({ type: 'noul', p: 0.9 })).toBe('satisfied');
    expect(bandOf({ type: 'noul', p: 0.5 })).toBe('unclear');
    expect(bandOf({ type: 'noul', p: 0.1 })).toBe('violated');
    expect(bandOf({ type: 'choice', choice: 'a', probabilities: {}, confidence: 0.2 }, { lo: 0.3, hi: 0.7 })).toBe('violated');
  });
});
