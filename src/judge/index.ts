import { JEV_DEFAULTS, JevJudge, type FetchLike } from './jev.ts';
import { ModelJudge, type CompleteLike } from './model.ts';
import { labelOf } from './bands.ts';
import type { Judge, Judgement, Questions } from './types.ts';

export type Backend = 'auto' | 'jev' | 'model' | 'off';

export type JudgeConfig = {
  backend: Backend;
  apiKey?: string;
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
      { apiKey: config.apiKey, model: config.jevModel, baseUrl: config.jevBaseUrl },
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
      reason: result.ok ? undefined : `${result.reason}: ${result.message}`,
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
