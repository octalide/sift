import type { Answer, Answers, Judge, Judgement, Questions } from './types.ts';

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: string }>;

export type JevConfig = {
  apiKey: string;
  model: string;
  baseUrl: string;
};

export const JEV_DEFAULTS = {
  model: 'jev-latest',
  baseUrl: 'https://api.typesafe.ai/v1/systemone',
};

export function buildRequest(config: JevConfig, state: unknown, questions: Questions) {
  return {
    url: config.baseUrl,
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: config.model, state, questions }),
  };
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// normalizes one raw answer into the plugin's Answer, or undefined when it does not fit its question
export function parseAnswer(raw: unknown, question: Questions[string]): Answer | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  switch (question.type) {
    case 'noul': {
      const p = num(r['noul']);
      return p === undefined ? undefined : { type: 'noul', p };
    }
    case 'choice': {
      const choice = r['choice'];
      const probabilities = r['probabilities'];
      if (typeof choice !== 'string' || probabilities === null || typeof probabilities !== 'object') return undefined;
      const probs: Record<string, number> = {};
      for (const [k, v] of Object.entries(probabilities as Record<string, unknown>)) {
        const p = num(v);
        if (p !== undefined) probs[k] = p;
      }
      const confidence = num(r['confidence']) ?? probs[choice] ?? 0;
      return { type: 'choice', choice, probabilities: probs, confidence };
    }
    case 'score': {
      const score = num(r['score']);
      const probabilities = Array.isArray(r['probabilities']) ? r['probabilities'].map(num) : [];
      if (score === undefined || probabilities.some((p) => p === undefined)) return undefined;
      const probs = probabilities as number[];
      const legend = typeof r['legend'] === 'string' ? r['legend'] : question.criteria[score] ?? String(score);
      const confidence = num(r['confidence']) ?? probs[score] ?? 0;
      return { type: 'score', score, legend, probabilities: probs, confidence };
    }
  }
}

export function parseResponse(text: string, questions: Questions): Answers | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'response is not JSON';
  }
  if (parsed === null || typeof parsed !== 'object') return 'response is not an object';
  const answers = (parsed as Record<string, unknown>)['answers'];
  if (answers === null || typeof answers !== 'object') return 'response has no answers';
  const out: Answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = parseAnswer((answers as Record<string, unknown>)[id], question);
    if (!answer) return `answer for ${id} does not fit its question`;
    out[id] = answer;
  }
  return out;
}

export class JevJudge implements Judge {
  readonly name = 'jev';
  constructor(
    private readonly config: JevConfig,
    private readonly fetchFn: FetchLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async ask(state: unknown, questions: Questions): Promise<Judgement> {
    const request = buildRequest(this.config, state, questions);
    const started = this.now();
    let response: { status: number; ok: boolean; text: string };
    try {
      response = await this.fetchFn(request.url, request);
    } catch (error) {
      return { ok: false, reason: 'unavailable', message: messageOf(error), backend: this.name };
    }
    const latencyMs = this.now() - started;
    if (response.status === 422) {
      return { ok: false, reason: 'rejected', message: response.text.slice(0, 300), backend: this.name };
    }
    if (!response.ok) {
      return { ok: false, reason: 'unavailable', message: `http ${response.status}`, backend: this.name };
    }
    const answers = parseResponse(response.text, questions);
    if (typeof answers === 'string') {
      return { ok: false, reason: 'malformed', message: answers, backend: this.name };
    }
    return { ok: true, answers, backend: this.name, latencyMs };
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
