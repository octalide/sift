import type { Answer, Answers, Judge, Judgement, KeySource, Questions, Usage } from './types.ts';
import { estimateTokens } from '../tokens.ts';

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: string }>;

export type JevConfig = {
  apiKey: string;
  model: string;
  baseUrl: string;
  keySource?: KeySource;
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

// jev keys level probabilities by index string, the model backend gives an array; both become an array by level
function levelProbabilities(raw: unknown, levels: number): number[] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const entries = Array.isArray(raw) ? raw.map((v, i) => [String(i), v] as const) : Object.entries(raw as Record<string, unknown>);
  const probs = new Array<number>(levels).fill(0);
  for (const [k, v] of entries) {
    const i = Number(k);
    const p = num(v);
    if (!Number.isInteger(i) || i < 0 || i >= levels || p === undefined) return undefined;
    probs[i] = p;
  }
  return probs;
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
      const probs = levelProbabilities(r['probabilities'], question.criteria.length);
      if (!probs) return undefined;
      const score = probs.indexOf(Math.max(...probs));
      const expected = num(r['score']) ?? probs.reduce((sum, p, i) => sum + p * i, 0);
      const legend = question.criteria[score] ?? String(score);
      const confidence = num(r['confidence']) ?? probs[score] ?? 0;
      return { type: 'score', score, expected, legend, probabilities: probs, confidence };
    }
  }
}

// the backend's usage block when the response carries one (input/output or prompt/completion names), else an estimate
export function usageOf(requestBody: string, responseText: string): Usage {
  try {
    const parsed = JSON.parse(responseText) as { usage?: Record<string, unknown> };
    const u = parsed.usage;
    const num = (...keys: string[]) => keys.map((k) => u?.[k]).find((v): v is number => typeof v === 'number');
    const inTok = num('input_tokens', 'prompt_tokens', 'state_tokens');
    const outTok = num('output_tokens', 'completion_tokens');
    if (inTok !== undefined) return { requestTokens: inTok, responseTokens: outTok ?? estimateTokens(responseText), source: 'backend' };
  } catch {
    // not json, estimated below
  }
  return { requestTokens: estimateTokens(requestBody), responseTokens: estimateTokens(responseText), source: 'estimate' };
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
      return { ok: false, reason: 'unavailable', message: messageOf(error), backend: this.name, usage: { requestTokens: estimateTokens(request.body), responseTokens: 0, source: 'estimate' } };
    }
    const latencyMs = this.now() - started;
    const usage = usageOf(request.body, response.text);
    if (response.status === 422) {
      return { ok: false, reason: 'rejected', message: response.text.slice(0, 300), backend: this.name, usage };
    }
    if (!response.ok) {
      // an authentication refusal names where the key came from, since the key that was sent may not be the one in view
      const keySource = response.status === 401 || response.status === 403 ? this.config.keySource : undefined;
      return { ok: false, reason: 'unavailable', message: `http ${response.status}: ${response.text.slice(0, 300)}`, backend: this.name, status: response.status, keySource, usage };
    }
    const answers = parseResponse(response.text, questions);
    if (typeof answers === 'string') {
      return { ok: false, reason: 'malformed', message: answers, backend: this.name, usage };
    }
    return { ok: true, answers, backend: this.name, latencyMs, usage };
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
