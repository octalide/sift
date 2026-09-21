import type { EngineInterface, PluginOptions, Register } from 'claude-code';

import { extractors, gateOutbound, outboundOf } from '../src/gate/outbound.ts';
import type { Forge } from '../src/forge/forge.ts';
import { localGit, type Git } from '../src/forge/git.ts';
import { GitHubForge } from '../src/forge/github.ts';
import { CONFIG_PATH, configLayers, defaultTarget, globalConfigPath, resolveConfig, type RepoConfig } from '../src/github/config.ts';
import { commitSubject, issueSubject, planSubject, prSubject, releaseSubject, rulesSubject, textSubject } from '../src/github/subjects.ts';
import { localSource, remoteSource } from '../src/github/source.ts';
import { indexTree, treeSubject } from '../src/locate/tree.ts';
import { digestOf, JUDGE_DEFAULTS, LoggedJudge, makeJudge, type Backend, type Decision } from '../src/judge/index.ts';
import { rank, type RankItem, type RankOptions } from '../src/judge/rank.ts';
import type { Answer, Judge, Questions } from '../src/judge/types.ts';
import { DecisionLog, type Cost } from '../src/log.ts';
import { loadPacks } from '../src/packs/load.ts';
import { formatReport, runPack } from '../src/packs/run.ts';
import { parseSubject, type ParsedKind } from '../src/packs/subject.ts';
import type { Pack, Report, Subject } from '../src/packs/types.ts';
import { prune, PRUNE_DEFAULTS } from '../src/prune/prune.ts';
import { estimateTokens, truncate } from '../src/tokens.ts';
import { Watcher } from '../src/watch/watcher.ts';

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

// everything the hooks share once the session is bound
type Runtime = {
  judge: Judge;
  log: DecisionLog;
  config: RepoConfig;
  packs: Record<string, Pack>;
  repo?: string;
  root?: string;
  forge: Forge;
  git: Git;
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

  async function subjectFor(rt: Runtime, packName: string, ref: string, opts: GradeOptions = {}): Promise<Subject> {
    const pack = rt.packs[packName];
    if (!pack) throw new Error(`unknown pack ${packName} (have: ${Object.keys(rt.packs).join(', ')})`);
    const repo = opts.repo ?? rt.repo;
    const needRepo = () => {
      if (!repo) throw new Error(`no repository: pass repo as the ${rt.forge.name} path or run inside a checkout with a ${rt.forge.name} remote`);
      return repo;
    };
    const number = () => Number(ref.replace(/^#/, ''));
    const fs = { read: (p: string) => rt.git(['show', `HEAD:${p}`]).catch(() => readFile(p)), exists: (p: string) => existsFile(p) };
    // the subject is parsed, and a bad one refused, before any forge request; a url names its own repo
    const parsed = <K extends ParsedKind>(kind: K) => parseSubject(kind, ref, rt.forge, opts.repo);
    switch (pack.subject) {
      case 'issue': {
        const p = parsed('issue');
        return issueSubject(rt.forge, p.repo ?? needRepo(), p.number, rt.config);
      }
      case 'pr': {
        const p = parsed('pr');
        return prSubject(rt.forge, p.repo ?? needRepo(), p.number, rt.config);
      }
      case 'commit':
        return commitSubject(rt.git, parsed('commit').ref, rt.config);
      case 'release': {
        const p = parsed('release');
        // the checkout serves its own repo; any other repo, or no checkout at all, is read from the forge
        const local = rt.repo !== undefined && (opts.repo === undefined || opts.repo === rt.repo);
        const source = local
          ? localSource(rt.git, opts.ref ?? 'HEAD', readFile, existsFile)
          : remoteSource(rt.forge, needRepo(), opts.ref ?? defaultTarget(rt.config) ?? (await rt.forge.defaultBranch(needRepo())));
        const s = await releaseSubject(source, rt.config);
        if (p.proposed !== undefined) s.facts['proposed'] = p.proposed;
        return s;
      }
      case 'rules': {
        const kind = /^#?\d+$/.test(ref) ? (opts.text === 'issue' ? 'issue' : 'pr') : /^[0-9a-f]{7,40}$|\.\./.test(ref) ? 'commit' : 'text';
        return rulesSubject({ forge: rt.forge, git: rt.git, repo, read: fs.read, exists: fs.exists }, { kind, ref: kind === 'text' ? (opts.text ?? ref) : ref }, rt.config);
      }
      case 'tree': {
        // an issue number with a repo is its title and body, anything else is the text itself
        const isIssue = /^#?\d+$/.test(ref) && opts.text === undefined && repo !== undefined;
        const issue = isIssue ? await rt.forge.issue(repo, number()) : undefined;
        const text = issue ? `${issue.title}\n\n${issue.body}` : (opts.text ?? ref);
        if (!rt.root) throw new Error('no checkout: the tree subject indexes the working directory');
        const root = rt.root;
        const index = await indexTree({
          list: async () => (await rt.git(['ls-files', '-z'])).split('\0'),
          size: async (p) => (await statFile(`${root}/${p}`)).size,
          read: (p) => readFile(`${root}/${p}`),
        });
        return treeSubject(text, issue ? `${repo}#${number()}` : truncate(text, 40), index);
      }
      case 'plan': {
        if (opts.text === undefined) throw new Error('the plan pack reads the plan from text: grade(pack: "plan", subject: "<issue number>", text: "<plan>")');
        return planSubject(rt.forge, needRepo(), number(), opts.text);
      }
      default:
        return textSubject(opts.text ?? ref);
    }
  }

  // file access via the engine, bound at session start
  let readFile: (p: string) => Promise<string> = async () => '';
  let existsFile: (p: string) => Promise<boolean> = async () => false;
  let statFile: (p: string) => Promise<{ size: number }> = async () => ({ size: 0 });

  type GradeOptions = { repo?: string; text?: string; ref?: string; top?: number };

  async function grade(rt: Runtime, packName: string, ref: string, opts?: GradeOptions): Promise<Report> {
    const pack = rt.packs[packName];
    if (!pack) throw new Error(`unknown pack ${packName}`);
    const subject = await subjectFor(rt, packName, ref, opts);
    const report = await runPack(pack, subject, rt.judge, rt.config, { top: opts?.top });
    record('grade', report.verdict, { digest: `${packName} ${subject.ref}` });
    return report;
  }

  on('engine.create', async (_$, e, next) => {
    const built = await next(e);
    const sift = {
      judge: (state: unknown, questions: Questions) => ready().judge.ask(state, questions),
      rank: <T extends RankItem>(items: T[], questions: Questions, opts: RankOptions) => rank(items, questions, ready().judge, opts),
      grade: (pack: string, subject: string, opts?: GradeOptions) => grade(ready(), pack, subject, opts),
      backend: () => (runtime ? runtime.judge.name : 'unbound'),
    };
    return { ...built, sift };
  });

  on('session.start', async ($, e, next) => {
    readFile = (p) => $.fs.read(p);
    existsFile = (p) => $.fs.exists(p);
    statFile = (p) => $.fs.stat(p);
    const store = { get: (k: string) => $.store.get(k), set: (k: string, v: unknown) => $.store.set(k, v) };
    const sessionId = await $.session.id();
    const log = new DecisionLog(store, sessionId);
    const apiKey = await apiKeyOf($, options);
    const inner = makeJudge(
      { backend: options.backend, apiKey, jevModel: options.jevModel, jevBaseUrl: options.jevBaseUrl, fallbackModel: options.fallbackModel },
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
    const git = localGit(run, spawnCwd);
    const checkout = await forge.checkout();
    const root = await spawnCwd();
    const globalPath = globalConfigPath({ XDG_CONFIG_HOME: await $.env.get('XDG_CONFIG_HOME'), HOME: await $.env.get('HOME') });
    const config = resolveConfig(
      configLayers({
        option: await optionConfig($, options.config, root),
        global: await readJson($, globalPath),
        repo: await readJson($, `${root}/${CONFIG_PATH}`),
      }),
      checkout?.defaultBranch,
    );
    const packs = await loadPacks({ read: (p) => $.fs.read(p), exists: (p) => $.fs.exists(p), list: (p) => $.fs.list(p) }, root);
    const startWatch = async (): Promise<string | undefined> => {
      const rt = ready();
      if (rt.watcher) return undefined;
      const repo = options.watchRepo || rt.repo;
      const triagePack = rt.packs['triage'];
      if (!repo) return `no repository to watch (set watchRepo or run in a checkout with a ${forge.name} remote)`;
      if (!triagePack) return 'triage pack missing';
      const watcher = new Watcher(
        {
          forge,
          store,
          judge,
          pack: triagePack,
          issuePack: rt.packs['issue'],
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
    runtime = { judge, log, config, packs, repo: checkout?.repo, root, forge, git, startWatch, sessionId };
    $.ui.log(`sift: judge ${judge.name}, repo ${runtime.repo ?? 'none'}, packs ${Object.keys(packs).join(' ')}`);

    if (options.grade) {
      await $.tool.register({
        name: 'grade',
        description:
          'Grade a repository subject with a sift pack and get mechanical findings plus calibrated judgements. Packs and what each expects as subject: issue (an issue number as N or #N, or an issue URL, which may name another repo), pr (a PR number as N or #N, or a PR URL), commit (a ref such as a sha, branch or tag, or a range like main..HEAD), release ("release" for the required bump alone, or a proposed version like v1.4.0; ref: the branch it is cut from, repo: any repo, no checkout needed), rules (a PR number, an issue number with text="issue", a commit, or free text in text), locate (an issue number, or free text in text, lists the files of the checkout to read or change for it, top: how many per level), plan (an issue number, text: the plan, judges whether the plan covers the issue, adds nothing beyond it, and decides nothing it leaves open). Never paste a title or body as the subject: it is a reference, the text goes in text. A missing or malformed subject is refused with the expected form named. Repo-defined packs under .sift/packs are available by name.',
        inputSchema: {
          type: 'object',
          properties: {
            pack: { type: 'string', description: 'pack name' },
            subject: { type: 'string', description: 'what the pack grades: an issue or PR number (N or #N) or URL, a commit ref or range, "release" or a version. See the pack list for what each accepts' },
            repo: { type: 'string', description: 'owner/name, defaults to the current repository. A release grade for another repo, or from a directory that is not a checkout, reads that repo from the code host' },
            text: { type: 'string', description: 'free text subject for the rules and locate packs, the plan for the plan pack, or "issue" to grade an issue number against the rules' },
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
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'start', 'poll', 'pause', 'resume', 'reset', 'deferred'] } } },
    });
    await $.command.register({ name: 'sift', description: 'sift status, log, watch control', argumentHint: '[status|log|clear|watch status|start|poll|pause|resume|reset|deferred]' });

    if (options.watch) {
      const reason = await startWatch();
      if (reason) $.ui.log(`sift watch: ${reason}`);
    }
    return next(e);
  });

  on('tool.call', { tool: 'mcp__sift__grade' }, async ($, e) => {
    const input = e as unknown as { pack: string; subject: string; repo?: string; text?: string; ref?: string; top?: number };
    try {
      const subject = input.subject === undefined || input.subject === null ? '' : String(input.subject);
      const report = await grade(ready(), input.pack, subject, { repo: input.repo, text: input.text, ref: input.ref, top: input.top });
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
      ? Object.entries(result.answers).map(([id, a]) => `${id}: ${answerLabel(a)}`).join('\n')
      : `judge unavailable: ${result.reason}: ${result.message}`;
    return result.ok ? { result: [{ type: 'text', text }] } : { deny: text };
  });

  on('tool.call', { tool: 'mcp__sift__rank' }, async ($, e) => {
    const input = e as unknown as { items: RankItem[]; questions: Questions; mode?: RankOptions['mode']; context?: Record<string, unknown>; by?: string; choice?: string };
    const result = await rank(input.items, input.questions, ready().judge, { mode: input.mode ?? 'batched', context: input.context, by: input.by, choice: input.choice });
    record('rank-tool', result.ok ? 'ranked' : 'failed', { digest: `${input.items.length} items, ${result.requests} requests` });
    if (!result.ok) return { deny: `rank unavailable: ${result.reason}: ${result.message}` };
    const lines = result.sorted.map((r) => `${r.index}: ${r.value.toFixed(3)} ${Object.entries(r.answers).map(([id, a]) => `${id}=${answerLabel(a)}`).join(' ')} ${digestOf(r.item)}`);
    return { result: [{ type: 'text', text: [`${result.items.length} items in ${result.requests} request${result.requests === 1 ? '' : 's'}, sorted by ${input.by ?? Object.keys(input.questions)[0]}`, ...lines].join('\n') }] };
  });

  // outbound gate before, prune after, on the same call
  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__sift__')) return next(e);
    const rt = runtime;
    if (!rt) return next(e);
    const outbound = options.gateOutbound ? await outboundOf(e.tool, e as unknown as Record<string, unknown>, readFile, extractors(rt.forge)) : undefined;
    if (outbound) {
      const rulesPack = rt.packs['rules'];
      const artifact = outbound.kind && outbound.action ? { kind: outbound.kind, action: outbound.action } : undefined;
      const subject = rulesPack ? await rulesSubject({ forge: rt.forge, git: rt.git, repo: rt.repo, read: readFile, exists: existsFile }, { kind: 'text', ref: outbound.text, artifact }, rt.config) : undefined;
      if (rulesPack && subject) {
        const decision = await gateOutbound(outbound, subject, rulesPack, rt.judge, rt.config);
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
    const watch = !rt.watcher ? 'watch: off' : `watch: ${w!.paused ? 'paused' : 'running'} on ${options.watchRepo || rt.repo}, ${w!.deferred.length} deferred, last poll ${w!.lastPoll ? new Date(w!.lastPoll).toISOString() : 'never'}`;
    return [
      `sift: judge ${rt.judge.name}${options.shadow ? ' (shadow mode)' : ''}, repo ${rt.repo ?? 'none'}`,
      `enabled: ${enabled}`,
      watch,
      `this session: ${stats.session.calls} decisions, ${stats.session.failures} failures${last ? ` (last ${last.module} at ${new Date(last.at).toISOString()}: ${last.backend}: ${last.reason ?? 'no reason'})` : ''}`,
      `all sessions (ring of 500): ${stats.calls} decisions, ${stats.failures} failures`,
      `cost this session: ${cost(stats.session.cost)}; ring: ${cost(stats.cost)} (tokens, estimated unless the backend reports them)`,
      modules || '  no decisions yet',
    ].join('\n');
  }

  // the watch controls, shared by /sift watch and the watch tool
  async function watchControl(rt: Runtime, sub: string): Promise<string> {
    if (sub === 'start') {
      const reason = await rt.startWatch();
      if (reason) return `watch cannot start: ${reason}`;
    }
    const w = rt.watcher;
    if (!w) return 'watch is off (start it with the start action, or set the watch option to start it at boot)';
    if (sub === 'pause') await w.pause();
    else if (sub === 'resume') await w.resume();
    else if (sub === 'reset') await w.reset();
    else if (sub === 'poll') await w.tick();
    const st = w.snapshot();
    if (sub === 'deferred') {
      return st.deferred.map((d) => `${d.reason.padEnd(24)} ${d.event.kind} ${d.event.number ?? ''} ${d.event.title} ${d.label ?? ''}`).join('\n') || 'nothing deferred';
    }
    return [
      `watch ${options.watchRepo || rt.repo}: ${st.paused ? 'paused' : 'running'}, ${Object.keys(st.items).length} items, ${Object.keys(st.runs).length} runs cached`,
      `interval ${Math.round(st.interval / 1000)}s, last poll ${st.lastPoll ? new Date(st.lastPoll).toISOString() : 'never'}, failures ${st.failures}`,
      `deferred ${st.deferred.length}, self login ${st.login ?? 'unknown'}, cursor ${st.cursor}`,
    ].join('\n');
  }

  on('tool.call', { tool: 'mcp__sift__watch' }, async ($, e) => {
    const rt = runtime;
    const action = String((e as unknown as { action?: string }).action ?? 'status');
    if (!rt) return { result: [{ type: 'text', text: 'sift is not bound yet' }] };
    if (!['status', 'start', 'poll', 'pause', 'resume', 'reset', 'deferred'].includes(action)) return { deny: `unknown watch action ${action}` };
    return { result: [{ type: 'text', text: await watchControl(rt, action) }] };
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
