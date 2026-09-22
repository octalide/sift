import type { EngineInterface, PluginOptions, Register } from 'claude-code';

import { channelTable, defaultChannels } from '../src/gate/channels.ts';
import { gateOutbound, outboundOf } from '../src/gate/outbound.ts';
import { GitHubForge } from '../src/forge/github.ts';
import { grade, ruleSource, scopeOf, SpawnDirs, type GradeHost, type GradeOptions } from '../src/grade.ts';
import { Checkouts, type Checkout } from '../src/repo/checkout.ts';
import { configLayers, globalConfigPath } from '../src/repo/config.ts';
import { rulesSubject } from '../src/repo/subjects.ts';
import { digestOf, judgeLine, JUDGE_DEFAULTS, LoggedJudge, makeJudge, resolveApiKey, type ApiKey, type Backend, type Decision } from '../src/judge/index.ts';
import { rank, type RankItem, type RankOptions } from '../src/judge/rank.ts';
import { failureText, type Answer, type Questions } from '../src/judge/types.ts';
import { DecisionLog, type Cost } from '../src/log.ts';
import { formatReport } from '../src/packs/run.ts';
import type { Report } from '../src/packs/types.ts';
import { prune, PRUNE_DEFAULTS } from '../src/prune/prune.ts';
import { estimateTokens } from '../src/tokens.ts';
import { armedNotice, armingAgent, Watcher } from '../src/watch/watcher.ts';

type Options = {
  backend: Backend;
  apiKey?: string;
  jevModel: string;
  jevBaseUrl: string;
  fallbackModel: string;
  shadow: boolean;
  prune: boolean;
  pruneFloorTokens: number;
  pruneChunkLines: number;
  pruneKeepThreshold: number;
  pruneTools: string;
  watch: boolean;
  watchRepo: string;
  watchMinInterval: number;
  watchMaxInterval: number;
  watchDelivery: 'prompt' | 'log';
  watchIgnoreSelf: boolean;
  watchIgnoreBots: boolean;
  watchCi: 'failures' | 'all' | 'none';
  watchTriage: boolean;
  watchDeferMaxAgeHours: number;
  watchStallHours: number;
  grade: boolean;
  gateOutbound: boolean;
  classify: boolean;
  // conventions under every repo's .sift/config.json: a path or inline json, replacing the global file
  config: string;
};

const DEFAULTS: Options = {
  backend: 'auto',
  jevModel: JUDGE_DEFAULTS.jevModel,
  jevBaseUrl: JUDGE_DEFAULTS.jevBaseUrl,
  fallbackModel: JUDGE_DEFAULTS.fallbackModel,
  shadow: false,
  prune: true,
  pruneFloorTokens: PRUNE_DEFAULTS.floorTokens,
  pruneChunkLines: PRUNE_DEFAULTS.chunkLines,
  pruneKeepThreshold: PRUNE_DEFAULTS.keepThreshold,
  pruneTools: 'Bash,Read',
  watch: false,
  watchRepo: '',
  watchMinInterval: 60,
  watchMaxInterval: 300,
  watchDelivery: 'prompt',
  watchIgnoreSelf: true,
  watchIgnoreBots: true,
  watchCi: 'failures',
  watchTriage: true,
  watchDeferMaxAgeHours: 24,
  watchStallHours: 1,
  grade: true,
  gateOutbound: false,
  classify: false,
  config: '',
};

export function resolveOptions(raw: PluginOptions): Options {
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof fallback === 'number' && typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof fallback === 'boolean' && typeof v === 'boolean') out[key] = v;
    else if (typeof fallback === 'string' && typeof v === 'string') out[key] = v;
  }
  if (typeof raw['apiKey'] === 'string' && raw['apiKey'].length > 0) out['apiKey'] = raw['apiKey'];
  return out as Options;
}

// everything the hooks share once the session is bound: what a grade reads through, and the session's own state
type Runtime = GradeHost & {
  // the jev key and its source, for the status line
  apiKey?: ApiKey;
  log: DecisionLog;
  // the session's checkout, resolved per call from the session's main working tree
  session: () => Promise<Checkout>;
  watcher?: Watcher;
  // builds and starts the watcher; returns the reason when it cannot
  startWatch: () => Promise<string | undefined>;
  sessionId: string;
};

// the config option is inline json or a path, relative to the repo root
async function optionConfig($: EngineInterface, value: string, root: string): Promise<unknown> {
  const v = value.trim();
  if (!v) return undefined;
  if (v.startsWith('{')) return JSON.parse(v);
  const path = v.startsWith('/') ? v : `${root}/${v}`;
  if (!(await $.fs.exists(path))) throw new Error(`sift config ${path} not found`);
  return JSON.parse(await $.fs.read(path));
}

// parsed contents of a json file, undefined when there is no such file
async function readJson($: EngineInterface, path: string | undefined): Promise<unknown> {
  if (!path || !(await $.fs.exists(path))) return undefined;
  return JSON.parse(await $.fs.read(path));
}

async function apiKeyOf($: EngineInterface, options: Options): Promise<ApiKey | undefined> {
  return resolveApiKey({ option: options.apiKey, env: () => $.env.get('TYPESAFE_API_KEY'), settings: () => $.settings.read() });
}

async function lastUserText($: EngineInterface): Promise<string> {
  const messages = await $.session.messages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.text.trim().length > 0) return m.text;
  }
  return '';
}

export const register: Register = (on, rawOptions) => {
  const options = resolveOptions(rawOptions);
  let runtime: Runtime | undefined;

  const record = (module: string, action: string, extra: Partial<Decision> = {}) => {
    runtime?.log.push({
      at: Date.now(),
      module,
      backend: runtime.judge.name,
      ok: true,
      digest: '',
      action,
      shadow: options.shadow,
      ...extra,
    });
  };

  const ready = (): Runtime => {
    if (!runtime) throw new Error('sift is not bound yet');
    return runtime;
  };

  // where each subagent was spawned; its grades default there
  const spawnDirs = new SpawnDirs();

  // file access via the engine, bound at session start
  let readFile: (p: string) => Promise<string> = async () => '';

  async function gradeIn(rt: Runtime, packName: string, ref: string, opts: GradeOptions = {}, agentId?: string): Promise<Report> {
    const { report, subject } = await grade(rt, await scopeOf(rt.checkouts, rt.session, opts.cwd, spawnDirs.of(agentId)), packName, ref, opts);
    record('grade', report.verdict, { digest: `${packName} ${subject.ref}` });
    return report;
  }

  on('engine.create', async (_$, e, next) => {
    const built = await next(e);
    const sift = {
      judge: (state: unknown, questions: Questions) => ready().judge.ask(state, questions),
      rank: <T extends RankItem>(items: T[], questions: Questions, opts: RankOptions) => rank(items, questions, ready().judge, opts),
      grade: (pack: string, subject: string, opts?: GradeOptions) => gradeIn(ready(), pack, subject, opts),
      backend: () => (runtime ? runtime.judge.name : 'unbound'),
    };
    return { ...built, sift };
  });

  on('session.start', async ($, e, next) => {
    readFile = (p) => $.fs.read(p);
    const fs = { read: (p: string) => $.fs.read(p), exists: (p: string) => $.fs.exists(p), list: (p: string) => $.fs.list(p), stat: (p: string) => $.fs.stat(p) };
    const store = { get: (k: string) => $.store.get(k), set: (k: string, v: unknown) => $.store.set(k, v) };
    const sessionId = await $.session.id();
    const log = new DecisionLog(store, sessionId);
    const apiKey = await apiKeyOf($, options);
    const inner = makeJudge(
      { backend: options.backend, apiKey: apiKey?.key, keySource: apiKey?.source, jevModel: options.jevModel, jevBaseUrl: options.jevBaseUrl, fallbackModel: options.fallbackModel },
      {
        fetch: (url, init) => $.http.fetch(url, init),
        complete: (request) => $.model.complete(request),
      },
    );
    const judge = new LoggedJudge(inner, (d) => log.push({ ...d, module: 'judge', action: 'ask', shadow: false }));
    // the main working tree, never a worktree the session started in and may later remove
    const spawnCwd = async () => (await $.session.repo())?.root ?? (await $.session.cwd());
    const run = (argv: readonly string[], init?: Parameters<typeof $.process.run>[1]) => $.process.run(argv, init);
    const forge = new GitHubForge(run, spawnCwd);
    const globalPath = globalConfigPath({ XDG_CONFIG_HOME: await $.env.get('XDG_CONFIG_HOME'), HOME: await $.env.get('HOME') });
    // the layer under every repository's own conventions, read once
    const [base] = configLayers({ option: await optionConfig($, options.config, await spawnCwd()), global: await readJson($, globalPath) });
    const checkouts = new Checkouts({ run, fs, forgeAt: (dir) => new GitHubForge(run, async () => dir), base: () => base });
    const session = async () => checkouts.resolve(await spawnCwd());
    const bound = await session();
    const startWatch = async (): Promise<string | undefined> => {
      const rt = ready();
      if (rt.watcher) return undefined;
      const { repo: sessionRepo, packs, config } = await rt.session();
      const repo = options.watchRepo || sessionRepo;
      const triagePack = packs['triage'];
      if (!repo) return `no repository to watch (set watchRepo or run in a checkout with a ${forge.name} remote)`;
      if (!triagePack) return 'triage pack missing';
      const watcher = new Watcher(
        {
          forge,
          store,
          judge,
          pack: triagePack,
          issuePack: packs['issue'],
          ciPack: packs['ci'],
          config,
          now: () => Date.now(),
          deliver: async (text) => {
            if (options.watchDelivery === 'log') {
              for (const line of text.split('\n')) $.ui.log(line);
              return;
            }
            await $.prompt.submit({ text });
          },
          log: (text) => $.ui.log(text),
          status: (text) => $.ui.status(text),
          schedule: (ms, fn) => $.clock.after(ms, fn),
          onDecision: (event, action, label) => rt.log.push({ at: Date.now(), module: 'watch', backend: judge.name, ok: true, digest: `${event.id} ${event.changes.join(',')}`, action, shadow: options.shadow, answers: { label } }),
        },
        {
          repo,
          minIntervalMs: options.watchMinInterval * 1000,
          maxIntervalMs: options.watchMaxInterval * 1000,
          deferMaxAgeMs: options.watchDeferMaxAgeHours * 3600 * 1000,
          stallMs: options.watchStallHours * 3600 * 1000,
          seedWindowMs: 90 * 24 * 3600 * 1000,
          rateFloor: 500,
          shadow: options.shadow,
          rules: {
            ignoreSelf: options.watchIgnoreSelf,
            ignoreBots: options.watchIgnoreBots,
            ci: options.watchCi,
            triage: options.watchTriage && options.backend !== 'off',
            protectedBranches: config.branches.protected,
            branchPattern: config.branches.pattern,
          },
        },
      );
      rt.watcher = watcher;
      await watcher.start();
      return undefined;
    };
    runtime = { judge, apiKey, log, forge, checkouts, session, fs, store, startWatch, sessionId };
    $.ui.log(`sift: judge ${judge.name}, repo ${bound.repo ?? 'none'}, packs ${Object.keys(bound.packs).join(' ')}`);

    if (options.grade) {
      await $.tool.register({
        name: 'grade',
        description:
          'Grade a repository subject with a sift pack and get mechanical findings plus calibrated judgements. Packs and what each expects as subject: issue (an issue number as N or #N, or an issue URL, which may name another repo), pr (a PR number as N or #N, a PR URL, or a range like dev..HEAD graded from the checkout before the PR exists; mechanical checks only: link, target, branch, CI, template, commit format, drift), commit (a ref such as a sha, branch or tag, or a range like main..HEAD; the commit format check only), release ("release" for the required bump alone, or a proposed version like v1.4.0; ref: the branch it is cut from, repo: any repo, no checkout needed), rules (an issue number or URL, or free text in text; a PR or commit is refused), locate (an issue number or URL, or free text in text, lists the files of the checkout to read or change for it, top: how many per level), plan (an issue number, text: the plan, judges whether the plan covers the issue, adds nothing beyond it, and decides nothing it leaves open), ci (a failed job as job:<id>, a run id or run:<id> for its first failed job, or the log in text; the lines that explain the failure, then whether the change under test caused it, whether it is the environment, and whether the fix is in this repository). Never paste a title or body as the subject: it is a reference, the text goes in text. A missing or malformed subject is refused with the expected form named. The grade reads one checkout: cwd when given (pass it from a worktree or another repository), else the directory the calling subagent was spawned in, else the session\'s repository; that checkout\'s .sift/config.json conventions and .sift/packs apply, and repo-defined packs are available by name.',
        inputSchema: {
          type: 'object',
          properties: {
            pack: { type: 'string', description: 'pack name' },
            subject: { type: 'string', description: 'what the pack grades: an issue or PR number (N or #N) or URL, a commit ref or range, "release" or a version. See the pack list for what each accepts' },
            repo: { type: 'string', description: 'owner/name, defaults to the repository of the checkout the grade reads. An issue, PR by number, plan or ci grade for another repo reads it from the code host under that repo\'s .sift/config.json; so does a release or rules grade when cwd is not given. A commit, PR range or locate grade refuses a repo that is not its checkout\'s' },
            cwd: { type: 'string', description: 'absolute path of the directory whose checkout the grade reads: its HEAD, working tree, .sift/config.json and .sift/packs, and its repository. Defaults to the directory the calling subagent was spawned in, else the session\'s repository. Pass it when working in a worktree or another repository' },
            text: { type: 'string', description: 'free text subject for the rules and locate packs, the plan for the plan pack, or a job log for the ci pack' },
            ref: { type: 'string', description: 'release pack: the branch or sha the release is cut from. Defaults to HEAD in a checkout, else the configured PR target branch, else the default branch' },
            top: { type: 'number', description: 'locate pack: how many paths to list per level, default 20' },
          },
          required: ['pack', 'subject'],
        },
      });
      await $.tool.register({
        name: 'judge',
        description:
          'Ask calibrated typed questions about any state without generating text. questions is an object of id -> {type: "noul"|"choice"|"score", instructions, criteria}. noul answers a probability, choice picks one key of criteria (an object of key -> description), score picks a position in criteria (an ordered array of level descriptions). Use it for classification, routing, and yes/no checks where a probability is more useful than prose.',
        inputSchema: {
          type: 'object',
          properties: {
            state: { description: 'what the questions are about: an object or a string' },
            questions: { type: 'object', description: 'id -> question' },
          },
          required: ['state', 'questions'],
        },
      });
      await $.tool.register({
        name: 'rank',
        description:
          'Score many items with the same typed questions and get them back in input order with their answers, plus a view sorted by one question. questions has the judge shape; {k} in a question stands for the item index and {field} for a field of an object item ({text} for a string item). mode "batched" fills each request with as many items as fit, so items can see each other and it is cheapest; "isolated" sends one request per item so no item colours another. Use it for "which of these N" problems: relevance, triage, dedup, picking a best candidate.',
        inputSchema: {
          type: 'object',
          properties: {
            items: { type: 'array', description: 'the items to score: strings or objects' },
            questions: { type: 'object', description: 'id -> question, asked of every item' },
            mode: { type: 'string', enum: ['batched', 'isolated'], description: 'batched (default) or isolated' },
            context: { type: 'object', description: 'state every item is read against, placed beside the items' },
            by: { type: 'string', description: 'the question the sorted view orders by, the first when absent' },
            choice: { type: 'string', description: 'for a choice question in by: the key whose probability orders the view' },
            fields: { type: 'array', items: { type: 'string' }, description: 'the item fields the state carries beside k, every field when absent; the others only fill the questions' },
          },
          required: ['items', 'questions'],
        },
      });
    }

    await $.tool.register({
      name: 'status',
      description: 'sift status: judge backend, enabled modules, whether the repo watch is running, and decision counts. Call it at session start to learn whether repository events will be delivered to you as prompts.',
      inputSchema: { type: 'object', properties: {} },
    });
    await $.tool.register({
      name: 'watch',
      description: 'Control the sift repo watch: status, start (build and start the watch when the session came up without it), poll (one poll now, delivering anything new), pause (stop polling until resumed), resume, reset (forget the cursor and reseed), deferred (list events held back).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'start', 'poll', 'pause', 'resume', 'reset', 'deferred'] },
          for: { type: 'string', description: 'start from a subagent only: the pull request that agent waits on, its number or head branch. A ci settled or ci stalled line on that pull request then names this agent, and once any agent has passed for, a ci line on a pull request no agent passed for names none' },
        },
      },
    });
    await $.command.register({ name: 'sift', description: 'sift status, log, watch control', argumentHint: '[status|log|clear|watch status|start|poll|pause|resume|reset|deferred]' });

    if (options.watch) {
      const reason = await startWatch();
      if (reason) $.ui.log(`sift watch: ${reason}`);
    }
    return next(e);
  });

  on('tool.call', { tool: 'mcp__sift__grade' }, async ($, e) => {
    const input = e as unknown as { pack: string; subject: string; repo?: string; cwd?: string; text?: string; ref?: string; top?: number };
    try {
      const subject = input.subject === undefined || input.subject === null ? '' : String(input.subject);
      const report = await gradeIn(ready(), input.pack, subject, { repo: input.repo, cwd: input.cwd, text: input.text, ref: input.ref, top: input.top }, e.agentId);
      return { result: [{ type: 'text', text: formatReport(report) }] };
    } catch (error) {
      return { deny: `sift grade failed: ${messageOf(error)}` };
    }
  });

  on('agent.spawn', async (_$, e, next) => {
    const r = await next(e);
    spawnDirs.spawned(r.agentId, e.cwd, e.parentAgentId);
    return r;
  });

  on('tool.call', { tool: 'mcp__sift__judge' }, async ($, e) => {
    const input = e as unknown as { state: unknown; questions: Questions };
    const result = await ready().judge.ask(input.state, input.questions);
    record('judge-tool', result.ok ? 'answered' : 'failed');
    const text = result.ok
      ? Object.entries(result.answers).map(([id, a]) => `${id}: ${answerLabel(a)}`).join('\n')
      : `judge unavailable: ${failureText(result)}`;
    return result.ok ? { result: [{ type: 'text', text }] } : { deny: text };
  });

  on('tool.call', { tool: 'mcp__sift__rank' }, async ($, e) => {
    const input = e as unknown as { items: RankItem[]; questions: Questions; mode?: RankOptions['mode']; context?: Record<string, unknown>; by?: string; choice?: string; fields?: string[] };
    const result = await rank(input.items, input.questions, ready().judge, { mode: input.mode ?? 'batched', context: input.context, by: input.by, choice: input.choice, fields: input.fields });
    record('rank-tool', result.ok ? 'ranked' : 'failed', { digest: `${input.items.length} items, ${result.requests} requests` });
    if (!result.ok) return { deny: `rank unavailable: ${failureText(result)}` };
    const lines = result.sorted.map((r) => `${r.index}: ${r.value.toFixed(3)} ${Object.entries(r.answers).map(([id, a]) => `${id}=${answerLabel(a)}`).join(' ')} ${digestOf(r.item)}`);
    return { result: [{ type: 'text', text: [`${result.items.length} items in ${result.requests} request${result.requests === 1 ? '' : 's'}, sorted by ${input.by ?? Object.keys(input.questions)[0]}`, ...lines].join('\n') }] };
  });

  // outbound gate before, prune after, on the same call
  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__sift__')) return next(e);
    const rt = runtime;
    if (!rt) return next(e);
    const session = options.gateOutbound ? await rt.session() : undefined;
    // the outbound channel table: the defaults for the forge, then the config's entries over them
    const outbound = session ? await outboundOf(e.tool, e as unknown as Record<string, unknown>, readFile, channelTable(defaultChannels(rt.forge), session.config.outbound.channels)) : undefined;
    if (session && outbound) {
      const rulesPack = session.packs['rules'];
      const scope = { checkout: session, named: false };
      const subject = rulesPack ? await rulesSubject({ forge: rt.forge, repo: session.repo, source: ruleSource(rt, scope, undefined), judge: rt.judge, store: rt.store }, { kind: 'text', ref: outbound.text, about: outbound.kind }, session.config) : undefined;
      if (rulesPack && subject) {
        const decision = await gateOutbound(outbound, subject, rulesPack, rt.judge, session.config);
        record('outbound', decision.allow ? 'allow' : options.shadow ? 'would-deny' : 'deny', { digest: `${outbound.channel} ${outbound.text.length} chars: ${decision.reason}` });
        for (const w of decision.warnings) $.ui.log(`sift outbound (${outbound.channel}): ${w}`);
        if (!decision.allow) {
          if (options.shadow) $.ui.log(`sift outbound (shadow): would deny ${outbound.channel} text: ${decision.reason}`);
          else return { deny: `sift outbound (${outbound.channel}): ${decision.reason}. Rewrite the text or ask the user.` };
        }
      }
    }
    const r = await next(e);
    if (!options.prune || !pruneTools(options).includes(e.tool) || r.deny !== undefined || r.isError) return r;
    const text = e.tool === 'Bash' ? (r.result as { stdout?: string } | undefined)?.stdout : e.tool === 'Read' ? (r.result as { type?: string; file?: { content?: string } } | undefined)?.file?.content : undefined;
    if (typeof text !== 'string' || estimateTokens(text) < options.pruneFloorTokens) return r;
    const input = e as unknown as Record<string, unknown>;
    const pruned = await prune(
      text,
      { tool: e.tool, input, task: await lastUserText($) },
      rt.judge,
      { ...PRUNE_DEFAULTS, floorTokens: options.pruneFloorTokens, chunkLines: options.pruneChunkLines, keepThreshold: options.pruneKeepThreshold },
    );
    if (pruned.error) {
      record('prune', 'fallback', { ok: false, reason: pruned.error, digest: e.tool });
      return r;
    }
    if (pruned.skipped || pruned.dropped === 0) {
      record('prune', 'none', { digest: `${e.tool}: ${pruned.skipped ?? 'nothing dropped'}` });
      return r;
    }
    const before = estimateTokens(text);
    const after = estimateTokens(pruned.text);
    record('prune', options.shadow ? 'would-prune' : 'pruned', { digest: `${e.tool}: ${pruned.dropped}/${pruned.chunks} chunks, ~${before - after} tokens`, tokensRemoved: before - after, answers: Object.fromEntries(Object.entries(pruned.scores).map(([k, v]) => [k, v.toFixed(2)])) });
    $.ui.toast(`sift${options.shadow ? ' (shadow)' : ''}: ${e.tool} output ${pruned.dropped}/${pruned.chunks} chunks dropped, ~${before - after} tokens`);
    if (options.shadow) return r;
    if (e.tool === 'Bash') return { result: { ...(r.result as Record<string, unknown>), stdout: pruned.text } };
    const read = r.result as { file: Record<string, unknown> } & Record<string, unknown>;
    return { result: { ...read, file: { ...read.file, content: pruned.text } } };
  });

  // a module that fell back since the last prompt says so once, beside the prompt, instead of hiding in a count
  on('prompt.submit', async (_$, e, next) => {
    const warnings = runtime?.log.takeWarnings() ?? [];
    if (warnings.length === 0) return next(e);
    return next({ ...e, context: [...(e.context ?? []), ...warnings] });
  });

  on('model.classify', async ($, e, next) => {
    const rt = runtime;
    if (!options.classify || !rt) return next(e);
    const criteria = Object.fromEntries(e.labels.map((l) => [l, l]));
    const result = await rt.judge.ask({ text: e.text }, { label: { type: 'choice', instructions: 'Which label fits the text best?', criteria } });
    if (!result.ok || result.answers['label']?.type !== 'choice') {
      record('classify', 'fallback', { ok: false, reason: result.ok ? 'no choice' : result.message, digest: e.text.slice(0, 60) });
      return next(e);
    }
    const answer = result.answers['label'];
    record('classify', options.shadow ? 'would-answer' : 'answered', { digest: e.text.slice(0, 60), answers: { label: `${answer.choice}@${answer.confidence.toFixed(2)}` } });
    if (options.shadow) return next(e);
    return { value: answer.choice };
  });

  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

  async function statusText(rt: Runtime): Promise<string> {
    const stats = await rt.log.stats();
    const modules = Object.entries(stats.byModule)
      .map(
        ([m, s]) =>
          `  ${m.padEnd(10)} calls ${String(s.calls).padStart(4)}  acted ${String(s.acted).padStart(4)}  shadow ${String(s.shadow).padStart(4)}  avg ${s.calls ? Math.round(s.latencyMs / s.calls) : 0}ms` +
          (s.requestTokens || s.responseTokens ? `  in ${k(s.requestTokens)} out ${k(s.responseTokens)}` : '') +
          (s.tokensRemoved ? `  removed ${k(s.tokensRemoved)}` : ''),
      )
      .join('\n');
    const cost = (c: Cost) => `judge in ${k(c.requestTokens)}, out ${k(c.responseTokens)}, context removed ${k(c.tokensRemoved)}`;
    const enabled = (Object.keys(options) as (keyof Options)[]).filter((k) => typeof options[k] === 'boolean' && options[k]).join(', ');
    const last = stats.session.lastFailure;
    const w = rt.watcher?.snapshot();
    const repo = (await rt.session()).repo;
    const watch = !rt.watcher ? 'watch: off' : `watch: ${w!.paused ? 'paused' : 'running'} on ${options.watchRepo || repo}, ${w!.deferred.length} deferred, last poll ${w!.lastPoll ? new Date(w!.lastPoll).toISOString() : 'never'}`;
    return [
      `sift: judge ${rt.judge.name}${options.shadow ? ' (shadow mode)' : ''}, repo ${repo ?? 'none'}`,
      judgeLine(rt.judge.name, rt.apiKey),
      `enabled: ${enabled}`,
      watch,
      `this session: ${stats.session.calls} decisions, ${stats.session.failures} failures${last ? ` (last ${last.module} at ${new Date(last.at).toISOString()}: ${last.backend}: ${last.reason ?? 'no reason'})` : ''}`,
      `all sessions (ring of 500): ${stats.calls} decisions, ${stats.failures} failures`,
      `cost this session: ${cost(stats.session.cost)}; ring: ${cost(stats.cost)} (tokens, estimated unless the backend reports them)`,
      modules || '  no decisions yet',
    ].join('\n');
  }

  // the watch controls, shared by /sift watch and the watch tool. armedBy is the subagent a start runs in, if any,
  // and ref the pr it named, so the verdict on that pr names it
  async function watchControl(rt: Runtime, sub: string, armedBy?: string, ref?: string): Promise<string> {
    if (sub === 'start') {
      const reason = await rt.startWatch();
      if (reason) return `watch cannot start: ${reason}`;
    }
    const w = rt.watcher;
    if (!w) return 'watch is off (start it with the start action, or set the watch option to start it at boot)';
    if (sub === 'start') await w.arm(armedBy, ref);
    if (sub === 'pause') await w.pause();
    else if (sub === 'resume') await w.resume();
    else if (sub === 'reset') await w.reset();
    else if (sub === 'poll') await w.tick();
    const st = w.snapshot();
    if (sub === 'deferred') {
      return st.deferred.map((d) => `${d.reason.padEnd(24)} ${d.event.kind} ${d.event.number ?? ''} ${d.event.title} ${d.label ?? ''}`).join('\n') || 'nothing deferred';
    }
    return [
      `watch ${options.watchRepo || (await rt.session()).repo}: ${st.paused ? 'paused' : 'running'}, ${Object.keys(st.items).length} items, ${Object.keys(st.runs).length} runs cached`,
      `interval ${Math.round(st.interval / 1000)}s, last poll ${st.lastPoll ? new Date(st.lastPoll).toISOString() : 'never'}, failures ${st.failures}`,
      `deferred ${st.deferred.length}, self login ${st.login ?? 'unknown'}, cursor ${st.cursor}`,
      ...(sub === 'start' && armedBy ? [armedNotice(armedBy)] : []),
    ].join('\n');
  }

  on('tool.call', { tool: 'mcp__sift__watch' }, async ($, e) => {
    const rt = runtime;
    const input = e as unknown as { action?: string; for?: string };
    const action = String(input.action ?? 'status');
    if (!rt) return { result: [{ type: 'text', text: 'sift is not bound yet' }] };
    if (!['status', 'start', 'poll', 'pause', 'resume', 'reset', 'deferred'].includes(action)) return { deny: `unknown watch action ${action}` };
    const armedBy = action === 'start' && e.agentId ? armingAgent(e.agentId, await $.agent.list()) : undefined;
    const ref = armedBy && input.for ? String(input.for).trim() || undefined : undefined;
    return { result: [{ type: 'text', text: await watchControl(rt, action, armedBy, ref) }] };
  });

  on('tool.call', { tool: 'mcp__sift__status' }, async () => {
    const rt = runtime;
    return { result: [{ type: 'text', text: rt ? await statusText(rt) : 'sift is not bound yet' }] };
  });

  on('command.run', { command: 'sift' }, async ($, e) => {
    const rt = runtime;
    if (!rt) return { text: 'sift is not bound yet' };
    const [head = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean);
    if (head === 'log') {
      const n = Number(rest[0]) || 30;
      const lines = (await rt.log.recent(n)).map((d) => `${new Date(d.at).toISOString().slice(11, 19)} ${d.module.padEnd(8)} ${d.action.padEnd(12)} ${d.digest}${d.answers ? ' ' + JSON.stringify(d.answers) : ''}${d.reason ? ' ' + d.reason : ''}`);
      return { text: lines.join('\n') || 'no decisions yet' };
    }
    if (head === 'clear') {
      await rt.log.clear();
      return { text: 'decision log cleared' };
    }
    if (head === 'watch') return { text: await watchControl(rt, rest[0] ?? 'status') };
    return { text: `${await statusText(rt)}\ncommands: /sift log [n], /sift clear, /sift watch status|start|poll|pause|resume|reset|deferred` };
  });
};

function pruneTools(options: Options): string[] {
  return options.pruneTools.split(',').map((t) => t.trim()).filter(Boolean);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function answerLabel(a: Answer): string {
  return a.type === 'noul' ? a.p.toFixed(3) : a.type === 'choice' ? `${a.choice} (confidence ${a.confidence.toFixed(2)})` : `${a.legend} (confidence ${a.confidence.toFixed(2)})`;
}
