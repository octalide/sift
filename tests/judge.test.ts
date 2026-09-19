import { describe, expect, it } from 'vitest';
import { bandOf } from '../src/judge/bands.ts';
import { JevJudge, parseResponse } from '../src/judge/jev.ts';
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
        level: { type: 'score', score: 1, legend: 'high', probabilities: [0.1, 0.9], confidence: 0.9 },
      },
    });
    const answers = parseResponse(body, questions);
    expect(typeof answers).toBe('object');
    if (typeof answers === 'string') throw new Error(answers);
    expect(answers['yes']).toEqual({ type: 'noul', p: 0.9 });
    expect(answers['pick']).toMatchObject({ type: 'choice', choice: 'b', confidence: 0.8 });
    expect(answers['level']).toMatchObject({ type: 'score', score: 1, legend: 'high' });
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
