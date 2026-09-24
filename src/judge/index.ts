import { JEV_DEFAULTS, JevJudge, type FetchLike } from './jev.ts';
import { ModelJudge, type CompleteLike } from './model.ts';
import { labelOf } from './bands.ts';
import { failureText, keyFix, keyRefText, shadowedText, type Judge, type Judgement, type KeyOrigin, type KeySource, type Questions } from './types.ts';

export type Backend = 'auto' | 'jev' | 'model' | 'off';

export type JudgeConfig = {
  backend: Backend;
  apiKey?: string;
  keyOrigin?: KeyOrigin;
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

// the key itself stays here; origin is what may be shown, its source, its last four characters and the other sources
export type ApiKey = { key: string; origin: KeyOrigin };

const ending = (key: string) => key.slice(-4);

// the credentials file of the session's config dir, where the engine keeps the apiKey option
export function credentialsPath(configDir: string | undefined): string {
  const dir = configDir?.replace(/\/+$/, '');
  return dir ? `${dir}/.credentials.json` : '~/.claude/.credentials.json';
}

// the jev key and where it came from: the apiKey option, then the environment, then the settings env block.
// every other source holding a key is named by its last four characters, so a shadowed key is visible.
// configDir is CLAUDE_CONFIG_DIR, which names the credentials file the option is stored in
export async function resolveApiKey(sources: {
  option?: string;
  env: () => Promise<string | undefined>;
  settings: () => Promise<Record<string, unknown>>;
  configDir: () => Promise<string | undefined>;
}): Promise<ApiKey | undefined> {
  const fromSettings = ((await sources.settings())['env'] as Record<string, unknown> | undefined)?.['TYPESAFE_API_KEY'];
  const held: { source: KeySource; key: string | undefined }[] = [
    { source: 'option', key: sources.option },
    { source: 'env', key: await sources.env() },
    { source: 'settings', key: typeof fromSettings === 'string' ? fromSettings : undefined },
  ];
  const [chosen, ...rest] = held.filter((h): h is { source: KeySource; key: string } => !!h.key);
  if (!chosen) return undefined;
  const others = rest.map((o) => ({ source: o.source, ending: ending(o.key), same: o.key === chosen.key }));
  const origin: KeyOrigin = { source: chosen.source, ending: ending(chosen.key), others };
  if (chosen.source === 'option') origin.stored = credentialsPath(await sources.configDir());
  return { key: chosen.key, origin };
}

// the backend in one line; for jev where its key came from, its last four characters and any shadowed key, never a key.
// a rejected key says so and names the fix
export function judgeLine(backend: string, origin?: KeyOrigin, rejected = false): string {
  if (backend !== 'jev' || !origin) return `judge: ${backend}`;
  const head = rejected
    ? [`judge: jev, key rejected from ${keyRefText(origin)}`, `fix: ${keyFix(origin)}`]
    : [`judge: jev, key from ${keyRefText(origin)}`];
  return [...head, ...shadowedText(origin)].join('; ');
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
      { apiKey: config.apiKey, model: config.jevModel, baseUrl: config.jevBaseUrl, keyOrigin: config.keyOrigin },
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
  // an outbound write let through over its ruling: the reason given, and the text written
  override?: string;
  text?: string;
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
  get keyRejected(): boolean {
    return this.inner.keyRejected ?? false;
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
