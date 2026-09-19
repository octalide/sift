import type { EngineInterface, PluginOptions, Register, SessionMessage } from 'claude-code';

import { compact, COMPACT_DEFAULTS, reduction, type Message } from '../src/compact/compact.ts';
import { gate as runGate, mentionsSecret } from '../src/gate/gate.ts';
import { CONFIG_PATH, resolveConfig, type RepoConfig } from '../src/github/config.ts';
import { Gh } from '../src/github/gh.ts';
import { commitSubject, issueSubject, prSubject, releaseSubject, rulesSubject, textSubject } from '../src/github/subjects.ts';
import { JUDGE_DEFAULTS, LoggedJudge, makeJudge, type Backend, type Decision } from '../src/judge/index.ts';
import type { Judge, Questions } from '../src/judge/types.ts';
import { DecisionLog } from '../src/log.ts';
import { loadPacks } from '../src/packs/load.ts';
import { formatReport, runPack } from '../src/packs/run.ts';
import type { Pack, Report, Subject } from '../src/packs/types.ts';
import { prune, PRUNE_DEFAULTS } from '../src/prune/prune.ts';
import { routeEffort, type Effort } from '../src/route/route.ts';
import { estimateTokens } from '../src/tokens.ts';
import { Watcher } from '../src/watch/watcher.ts';

type Options = {
  backend: Backend;
  apiKey?: string;
  jevModel: string;
  jevBaseUrl: string;
  fallbackModel: string;
  shadow: boolean;
  compact: boolean;
  compactKeepThreshold: number;
  compactPinRecent: number;
  compactMinReduction: number;
  compactTruncateHead: number;
  compactAtPercent: number;
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
  grade: boolean;
  gate: boolean;
  gateFailClosed: boolean;
  classify: boolean;
  route: boolean;
  routeMinEffort: Effort;
  routeMaxEffort: Effort;
};

const DEFAULTS: Options = {
  backend: 'auto',
  jevModel: JUDGE_DEFAULTS.jevModel,
  jevBaseUrl: JUDGE_DEFAULTS.jevBaseUrl,
  fallbackModel: JUDGE_DEFAULTS.fallbackModel,
  shadow: false,
  compact: true,
  compactKeepThreshold: COMPACT_DEFAULTS.keepThreshold,
  compactPinRecent: COMPACT_DEFAULTS.pinRecent,
  compactMinReduction: 0.25,
  compactTruncateHead: COMPACT_DEFAULTS.truncateHead,
  compactAtPercent: 0,
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
  grade: true,
  gate: false,
  gateFailClosed: true,
  classify: false,
  route: false,
  routeMinEffort: 'low',
  routeMaxEffort: 'high',
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

// everything the hooks share once the session is bound
type Runtime = {
  judge: Judge;
  log: DecisionLog;
  config: RepoConfig;
  packs: Record<string, Pack>;
  repo?: string;
  root?: string;
  gh: Gh;
  watcher?: Watcher;
  sessionId: string;
  archiveDir: string;
};

async function apiKeyOf($: EngineInterface, options: Options): Promise<string | undefined> {
  if (options.apiKey) return options.apiKey;
  const env = await $.env.get('TYPESAFE_API_KEY');
  if (env) return env;
  const settings = await $.settings.read();
  const fromSettings = (settings['env'] as Record<string, unknown> | undefined)?.['TYPESAFE_API_KEY'];
  return typeof fromSettings === 'string' && fromSettings ? fromSettings : undefined;
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
  let compacting = false;

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

  async function subjectFor(rt: Runtime, packName: string, ref: string, opts: { repo?: string; text?: string } = {}): Promise<Subject> {
    const pack = rt.packs[packName];
    if (!pack) throw new Error(`unknown pack ${packName} (have: ${Object.keys(rt.packs).join(', ')})`);
    const repo = opts.repo ?? rt.repo;
    const needRepo = () => {
      if (!repo) throw new Error('no repository: pass repo as owner/name or run inside a checkout with a GitHub remote');
      return repo;
    };
    const number = () => Number(ref.replace(/^#/, ''));
    const fs = { read: (p: string) => rt.gh.git(['show', `HEAD:${p}`]).catch(() => readFile(p)), exists: (p: string) => existsFile(p) };
    switch (pack.subject) {
      case 'issue':
        return issueSubject(rt.gh, needRepo(), number(), rt.config);
      case 'pr':
        return prSubject(rt.gh, needRepo(), number(), rt.config);
      case 'commit':
        return commitSubject(rt.gh, ref || 'HEAD', rt.config);
      case 'release': {
        const s = await releaseSubject(rt.gh, rt.config, fs.read, fs.exists);
        if (ref && ref !== 'release') s.facts['proposed'] = ref;
        return s;
      }
      case 'rules': {
        const kind = /^#?\d+$/.test(ref) ? (opts.text === 'issue' ? 'issue' : 'pr') : /^[0-9a-f]{7,40}$|\.\./.test(ref) ? 'commit' : 'text';
        return rulesSubject(rt.gh, repo, { kind, ref: kind === 'text' ? (opts.text ?? ref) : ref }, rt.config, fs.read, fs.exists);
      }
      default:
        return textSubject(opts.text ?? ref);
    }
  }

  // file access via the engine, bound at session start
  let readFile: (p: string) => Promise<string> = async () => '';
  let existsFile: (p: string) => Promise<boolean> = async () => false;

  async function grade(rt: Runtime, packName: string, ref: string, opts?: { repo?: string; text?: string }): Promise<Report> {
    const pack = rt.packs[packName];
    if (!pack) throw new Error(`unknown pack ${packName}`);
    const subject = await subjectFor(rt, packName, ref, opts);
    const report = await runPack(pack, subject, rt.judge, rt.config);
    record('grade', report.verdict, { digest: `${packName} ${subject.ref}` });
    return report;
  }

  on('engine.create', async (_$, e, next) => {
    const built = await next(e);
    const sift = {
      judge: (state: unknown, questions: Questions) => ready().judge.ask(state, questions),
      grade: (pack: string, subject: string, opts?: { repo?: string; text?: string }) => grade(ready(), pack, subject, opts),
      backend: () => (runtime ? runtime.judge.name : 'unbound'),
    };
    return { ...built, sift };
  });

  on('session.start', async ($, e, next) => {
    readFile = (p) => $.fs.read(p);
    existsFile = (p) => $.fs.exists(p);
    const store = { get: (k: string) => $.store.get(k), set: (k: string, v: unknown) => $.store.set(k, v) };
    const log = new DecisionLog(store);
    const apiKey = await apiKeyOf($, options);
    const inner = makeJudge(
      { backend: options.backend, apiKey, jevModel: options.jevModel, jevBaseUrl: options.jevBaseUrl, fallbackModel: options.fallbackModel },
      {
        fetch: (url, init) => $.http.fetch(url, init),
        complete: (request) => $.model.complete(request),
      },
    );
    const judge = new LoggedJudge(inner, (d) => log.push({ ...d, module: 'judge', action: 'ask', shadow: false }));
    const cwd = await $.session.cwd();
    const gh = new Gh((argv, init) => $.process.run(argv, init), cwd);
    const repoInfo = await gh.repoInfo();
    const sessionRepo = await $.session.repo();
    const root = sessionRepo?.root ?? cwd;
    const rawConfig = (await $.fs.exists(`${root}/${CONFIG_PATH}`)) ? JSON.parse(await $.fs.read(`${root}/${CONFIG_PATH}`)) : undefined;
    const config = resolveConfig(rawConfig, repoInfo?.defaultBranch);
    const packs = await loadPacks({ read: (p) => $.fs.read(p), exists: (p) => $.fs.exists(p), list: (p) => $.fs.list(p) }, root);
    const home = (await $.env.get('HOME')) ?? '/tmp';
    const sessionId = await $.session.id();
    runtime = { judge, log, config, packs, repo: repoInfo?.nameWithOwner, root, gh, sessionId, archiveDir: `${home}/.cache/sift/${sessionId}` };
    $.ui.log(`sift: judge ${judge.name}, repo ${runtime.repo ?? 'none'}, packs ${Object.keys(packs).join(' ')}`);

    if (options.grade) {
      await $.tool.register({
        name: 'grade',
        description:
          'Grade a repository subject with a sift pack and get mechanical findings plus calibrated judgements. Packs: issue (subject: issue number), pr (PR number), commit (sha or range like main..HEAD), release (subject: "release" or a proposed version like v1.4.0), rules (subject: PR number, issue number with text="issue", commit, or free text in text). Repo-defined packs under .sift/packs are available by name.',
        inputSchema: {
          type: 'object',
          properties: {
            pack: { type: 'string', description: 'pack name' },
            subject: { type: 'string', description: 'issue or PR number, commit or range, "release", or a version' },
            repo: { type: 'string', description: 'owner/name, defaults to the current repository' },
            text: { type: 'string', description: 'free text subject for the rules pack, or "issue" to grade an issue number against the rules' },
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
    }

    await $.tool.register({
      name: 'status',
      description: 'sift status: judge backend, enabled modules, whether the repo watch is running, and decision counts. Call it at session start to learn whether repository events will be delivered to you as prompts.',
      inputSchema: { type: 'object', properties: {} },
    });
    await $.command.register({ name: 'sift', description: 'sift status, log, watch control', argumentHint: '[status|log|clear|watch status|poll|pause|resume|reset|deferred]' });

    if (options.watch) {
      const repo = options.watchRepo || runtime.repo;
      const triagePack = packs['triage'];
      if (!repo) $.ui.log('sift watch: no repository to watch (set watchRepo or run in a checkout with a GitHub remote)');
      else if (!triagePack) $.ui.log('sift watch: triage pack missing');
      else {
        const rt = runtime;
        const watcher = new Watcher(
          {
            gh,
            store,
            judge,
            pack: triagePack,
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
        runtime.watcher = watcher;
        await watcher.start();
      }
    }
    return next(e);
  });

  on('tool.call', { tool: 'mcp__sift__grade' }, async ($, e) => {
    const input = e as unknown as { pack: string; subject: string; repo?: string; text?: string };
    try {
      const report = await grade(ready(), input.pack, String(input.subject), { repo: input.repo, text: input.text });
      return { result: [{ type: 'text', text: formatReport(report) }] };
    } catch (error) {
      return { deny: `sift grade failed: ${messageOf(error)}` };
    }
  });

  on('tool.call', { tool: 'mcp__sift__judge' }, async ($, e) => {
    const input = e as unknown as { state: unknown; questions: Questions };
    const result = await ready().judge.ask(input.state, input.questions);
    record('judge-tool', result.ok ? 'answered' : 'failed');
    const text = result.ok
      ? Object.entries(result.answers)
          .map(([id, a]) => `${id}: ${a.type === 'noul' ? a.p.toFixed(3) : a.type === 'choice' ? `${a.choice} (confidence ${a.confidence.toFixed(2)})` : `${a.legend} (confidence ${a.confidence.toFixed(2)})`}`)
          .join('\n')
      : `judge unavailable: ${result.reason}: ${result.message}`;
    return result.ok ? { result: [{ type: 'text', text }] } : { deny: text };
  });

  // gate before, prune after, on the same call
  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__sift__')) return next(e);
    const rt = runtime;
    if (!rt) return next(e);
    const gated = options.gate && (e.tool === 'Bash' || e.tool === 'Write' || e.tool === 'Edit');
    if (gated) {
      const gatePack = rt.packs['gate'];
      const input = e as unknown as Record<string, unknown>;
      const g = { tool: e.tool, input, cwd: await $.session.cwd(), repoRoot: rt.root, task: await lastUserText($) };
      if (mentionsSecret(g)) {
        record('gate', 'skipped', { digest: `${e.tool} mentions a secret, not sent to the judge` });
      } else if (gatePack) {
        const decision = await runGate(g, gatePack, rt.judge, rt.config, options.gateFailClosed);
        record('gate', decision.allow ? 'allow' : options.shadow ? 'would-deny' : 'deny', { digest: `${e.tool}: ${decision.reason}` });
        if (!decision.allow) {
          if (options.shadow) $.ui.log(`sift gate (shadow): would deny ${e.tool}: ${decision.reason}`);
          else return { deny: `sift gate: ${decision.reason}. Ask the user before retrying.` };
        }
      }
    }
    const r = await next(e);
    if (!options.prune || !pruneTools(options).includes(e.tool) || r.deny !== undefined || r.isError) return r;
    const text = e.tool === 'Bash' ? (r.result as { stdout?: string } | undefined)?.stdout : e.tool === 'Read' ? (r.result as { type?: string; file?: { content?: string } } | undefined)?.file?.content : undefined;
    if (typeof text !== 'string' || estimateTokens(text) < options.pruneFloorTokens) return r;
    const archivePath = `${rt.archiveDir}/${e.tool_use_id ?? Date.now()}.txt`;
    try {
      await $.fs.write(archivePath, text);
    } catch {
      // archive is a convenience; pruning proceeds with a recovery note that names the tool call instead
    }
    const input = e as unknown as Record<string, unknown>;
    const pruned = await prune(
      text,
      { tool: e.tool, input, task: await lastUserText($), archivePath },
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
    record('prune', options.shadow ? 'would-prune' : 'pruned', { digest: `${e.tool}: ${pruned.dropped}/${pruned.chunks} chunks, ~${before - after} tokens`, answers: Object.fromEntries(Object.entries(pruned.scores).map(([k, v]) => [k, v.toFixed(2)])) });
    $.ui.toast(`sift${options.shadow ? ' (shadow)' : ''}: ${e.tool} output ${pruned.dropped}/${pruned.chunks} chunks dropped, ~${before - after} tokens`);
    if (options.shadow) return r;
    if (e.tool === 'Bash') return { result: { ...(r.result as Record<string, unknown>), stdout: pruned.text } };
    const read = r.result as { file: Record<string, unknown> } & Record<string, unknown>;
    return { result: { ...read, file: { ...read.file, content: pruned.text } } };
  });

  on('session.compact', async ($, e, next) => {
    const rt = runtime;
    if (!options.compact || !rt || e.trigger === 'precompute') return next(e);
    try {
      const result = await compact(e.messages as unknown as Message[], rt.judge, {
        ...COMPACT_DEFAULTS,
        keepThreshold: options.compactKeepThreshold,
        pinRecent: options.compactPinRecent,
        truncateHead: options.compactTruncateHead,
        instructions: e.instructions,
      });
      if (result.error) {
        record('compact', 'fallback', { ok: false, reason: result.error, digest: `${e.messages.length} messages` });
        $.ui.log(`sift compact: built-in summary (${result.error})`);
        return next(e);
      }
      const ratio = reduction(result);
      const summary = `${Math.round(ratio * 100)}% smaller, ${result.decisions.filter((d) => d.action === 'drop').length} calls dropped, ${result.decisions.filter((d) => d.action === 'truncate').length} results truncated, ${result.requests} request(s)`;
      if (ratio < options.compactMinReduction) {
        record('compact', 'fallback', { digest: `below minimum: ${summary}` });
        $.ui.log(`sift compact: built-in summary (${summary}, under ${Math.round(options.compactMinReduction * 100)}% minimum)`);
        return next(e);
      }
      record('compact', options.shadow ? 'would-compact' : 'compacted', { digest: summary });
      if (options.shadow) {
        $.ui.log(`sift compact (shadow): would keep ${result.messages.length}/${e.messages.length} messages, ${summary}`);
        return next(e);
      }
      $.ui.toast(`sift compact: kept ${result.messages.length}/${e.messages.length} messages verbatim, ${summary}`, { timeoutMs: 10_000 });
      return { messages: result.messages as unknown as SessionMessage[] };
    } catch (error) {
      $.ui.log(`sift compact: built-in summary (${messageOf(error)})`);
      return next(e);
    }
  });

  on('turn.complete', async ($, e, next) => {
    if (options.compactAtPercent <= 0 || compacting) return next(e);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) >= options.compactAtPercent) {
        compacting = true;
        await $.session.compact();
      }
    } catch (error) {
      $.ui.log(`sift: auto-compact skipped (${messageOf(error)})`);
    } finally {
      compacting = false;
    }
    return next(e);
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

  on('turn.step', async function* ($, e, next) {
    const rt = runtime;
    if (!options.route || !rt || e.index !== 0 || e.agentId !== undefined || e.effort === undefined) return yield* next(e);
    const routePack = rt.packs['route'];
    if (!routePack) return yield* next(e);
    const prompt = await lastUserText($);
    const decision = await routeEffort(prompt, routePack, rt.judge, rt.config, options.routeMinEffort, options.routeMaxEffort);
    record('route', decision.effort ? (options.shadow ? 'would-route' : 'routed') : 'none', { digest: prompt.slice(0, 60), answers: { effort: decision.label } });
    if (!decision.effort || options.shadow || decision.effort === e.effort) return yield* next(e);
    $.ui.status(`sift route: ${decision.effort}`);
    return yield* next({ ...e, effort: decision.effort });
  });

  async function statusText(rt: Runtime): Promise<string> {
    const stats = await rt.log.stats();
    const modules = Object.entries(stats.byModule)
      .map(([m, s]) => `  ${m.padEnd(10)} calls ${String(s.calls).padStart(4)}  acted ${String(s.acted).padStart(4)}  shadow ${String(s.shadow).padStart(4)}  avg ${s.calls ? Math.round(s.latencyMs / s.calls) : 0}ms`)
      .join('\n');
    const enabled = (Object.keys(options) as (keyof Options)[]).filter((k) => typeof options[k] === 'boolean' && options[k]).join(', ');
    const w = rt.watcher?.snapshot();
    const watch = !rt.watcher ? 'watch: off' : `watch: ${w!.paused ? 'paused' : 'running'} on ${options.watchRepo || rt.repo}, ${w!.deferred.length} deferred, last poll ${w!.lastPoll ? new Date(w!.lastPoll).toISOString() : 'never'}`;
    return [
      `sift: judge ${rt.judge.name}${options.shadow ? ' (shadow mode)' : ''}, repo ${rt.repo ?? 'none'}`,
      `enabled: ${enabled}`,
      watch,
      `judge calls ${stats.calls}, failures ${stats.failures}`,
      modules || '  no decisions yet',
    ].join('\n');
  }

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
    if (head === 'watch') {
      const w = rt.watcher;
      if (!w) return { text: 'watch is off (enable the watch option and restart the session)' };
      const sub = rest[0] ?? 'status';
      if (sub === 'pause') await w.pause();
      else if (sub === 'resume') await w.resume();
      else if (sub === 'reset') await w.reset();
      else if (sub === 'poll') await w.tick();
      const s = w.snapshot();
      if (sub === 'deferred') {
        return { text: s.deferred.map((d) => `${d.reason.padEnd(24)} ${d.event.kind} ${d.event.number ?? ''} ${d.event.title} ${d.label ?? ''}`).join('\n') || 'nothing deferred' };
      }
      return {
        text: [
          `watch ${options.watchRepo || rt.repo}: ${s.paused ? 'paused' : 'running'}, ${Object.keys(s.items).length} items, ${Object.keys(s.runs).length} runs cached`,
          `interval ${Math.round(s.interval / 1000)}s, last poll ${s.lastPoll ? new Date(s.lastPoll).toISOString() : 'never'}, failures ${s.failures}`,
          `deferred ${s.deferred.length}, self login ${s.login ?? 'unknown'}, cursor ${s.cursor}`,
        ].join('\n'),
      };
    }
    return { text: `${await statusText(rt)}\ncommands: /sift log [n], /sift clear, /sift watch status|poll|pause|resume|reset|deferred` };
  });
};

function pruneTools(options: Options): string[] {
  return options.pruneTools.split(',').map((t) => t.trim()).filter(Boolean);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
