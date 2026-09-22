import { JEV_DEFAULTS, JevJudge, type FetchLike } from './jev.ts';
import { ModelJudge, type CompleteLike } from './model.ts';
import { labelOf } from './bands.ts';
import { failureText, KEY_SOURCE_LABEL, type Judge, type Judgement, type KeySource, type Questions } from './types.ts';

export type Backend = 'auto' | 'jev' | 'model' | 'off';

export type JudgeConfig = {
  backend: Backend;
  apiKey?: string;
  keySource?: KeySource;
  jevModel: string;
  jevBaseUrl: string;
  fallbackModel: string;
};

export const JUDGE_DEFAULTS: JudgeConfig = {
  backend: 'auto',
  jevModel: JEV_DEFAULTS.model,
  jevBaseUrl: JEV_DEFAULTS.baseUrl,
  fallbackModel: 'haiku',
};

export type ApiKey = { key: string; source: KeySource };

// the jev key and where it came from: the apiKey option, then the environment, then the settings env block
export async function resolveApiKey(sources: {
  option?: string;
  env: () => Promise<string | undefined>;
  settings: () => Promise<Record<string, unknown>>;
}): Promise<ApiKey | undefined> {
  if (sources.option) return { key: sources.option, source: 'option' };
  const env = await sources.env();
  if (env) return { key: env, source: 'env' };
  const fromSettings = ((await sources.settings())['env'] as Record<string, unknown> | undefined)?.['TYPESAFE_API_KEY'];
  return typeof fromSettings === 'string' && fromSettings ? { key: fromSettings, source: 'settings' } : undefined;
}

// the backend in one line, and for jev where its key came from and its last four characters, never the key
export function judgeLine(backend: string, apiKey?: ApiKey): string {
  if (backend !== 'jev' || !apiKey) return `judge: ${backend}`;
  return `judge: jev, key from ${KEY_SOURCE_LABEL[apiKey.source]} (ending ${apiKey.key.slice(-4)})`;
}

export class DisabledJudge implements Judge {
  readonly name = 'off';
  async ask(): Promise<Judgement> {
    return { ok: false, reason: 'disabled', message: 'judge backend is off', backend: this.name };
  }
}

export type JudgeHost = {
  fetch: FetchLike;
  complete: CompleteLike;
  now?: () => number;
};

export function makeJudge(config: JudgeConfig, host: JudgeHost): Judge {
  const wantJev = config.backend === 'jev' || (config.backend === 'auto' && !!config.apiKey);
  if (config.backend === 'off') return new DisabledJudge();
  if (wantJev) {
    if (!config.apiKey) return new DisabledJudge();
    return new JevJudge(
      { apiKey: config.apiKey, model: config.jevModel, baseUrl: config.jevBaseUrl, keySource: config.keySource },
      host.fetch,
      host.now,
    );
  }
  return new ModelJudge(config.fallbackModel, host.complete, host.now);
}

export type Decision = {
  at: number;
  module: string;
  backend: string;
  ok: boolean;
  latencyMs?: number;
  reason?: string;
  digest: string;
  answers?: Record<string, string>;
  action: string;
  shadow: boolean;
  // the session that made the decision; the ring is shared by every session running the plugin
  session?: string;
  // what a judge call cost, and what a prune took out of the context
  requestTokens?: number;
  responseTokens?: number;
  tokensRemoved?: number;
};

// a judge that records every call for the /sift report and calibration
export class LoggedJudge implements Judge {
  readonly name: string;
  constructor(
    private readonly inner: Judge,
    private readonly record: (d: Omit<Decision, 'action' | 'shadow' | 'module'>) => void,
  ) {
    this.name = inner.name;
  }
  async ask(state: unknown, questions: Questions): Promise<Judgement> {
    const result = await this.inner.ask(state, questions);
    this.record({
      at: Date.now(),
      backend: result.backend,
      ok: result.ok,
      latencyMs: result.ok ? result.latencyMs : undefined,
      reason: result.ok ? undefined : failureText(result),
      requestTokens: result.usage?.requestTokens,
      responseTokens: result.usage?.responseTokens,
      digest: digestOf(state),
      answers: result.ok
        ? Object.fromEntries(Object.entries(result.answers).map(([k, a]) => [k, labelOf(a)]))
        : undefined,
    });
    return result;
  }
}

export function digestOf(state: unknown): string {
  const text = typeof state === 'string' ? state : JSON.stringify(state);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
