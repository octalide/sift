import type { EngineInterface, PluginOptions, Register } from 'claude-code';

import { POST_TOOL, postKind } from '../src/gate/channels.ts';
import { enact, gateCall, gateText, OUTBOUND_MODES, verdictLater, verdictOf, type Gated, type Later, type OutboundMode } from '../src/gate/outbound.ts';
import { METHODS, pendingNote, postCall, rawWriteOf, VERDICTS, type PostInput } from '../src/gate/post.ts';
import { fallbackNote, gateShellWrite } from '../src/gate/shell.ts';
import { Verdicts } from '../src/gate/verdicts.ts';
import { ghWriteOf, GitHubForge } from '../src/forge/github.ts';
import { grade, ruleSource, scopeOf, type GradeHost, type GradeOptions } from '../src/grade.ts';
import { Checkouts, type Checkout } from '../src/repo/checkout.ts';
import { configLayers, globalConfigPath, readConfig } from '../src/repo/config.ts';
import { digestOf, judgeLine, JUDGE_DEFAULTS, LoggedJudge, makeJudge, resolveApiKey, type ApiKey, type Backend, type Decision } from '../src/judge/index.ts';
import { rank, type RankItem, type RankOptions, type RankResult } from '../src/judge/rank.ts';
import { failureText, type Answer, type Judgement, type KeyOrigin, type Questions } from '../src/judge/types.ts';
import { DecisionLog, type Cost } from '../src/log.ts';
import { formatReport } from '../src/packs/run.ts';
import type { Report } from '../src/packs/types.ts';
import { pruneCall } from '../src/prune/call.ts';
import { PRUNE_TOOL, PruneLoops } from '../src/prune/loops.ts';
import { PRUNE_DEFAULTS } from '../src/prune/prune.ts';
import { Discoveries, DISCOVERY_WAIT_MS, forgeSource } from '../src/rules/discover.ts';
import { Watches } from '../src/watch/registry.ts';
import { CI_FILTERS, commandInputOf, formatSubscription, subscriptionOf, type CiFilter, type Filter, type SubscribeInput } from '../src/watch/subscription.ts';
import { GRACE_MS, Mailbox, ownerNotice, refusalOf } from '../src/watch/mailbox.ts';
import { SEEN_EVERY_MS, sessionKeys, StoreKeys } from '../src/keys.ts';
import { Spawns } from '../src/spawns.ts';
import { Tenure, tenureToken } from '../src/tenure.ts';
import type { SiftAnswer, SiftGradeOptions, SiftJudgement, SiftQuestion, SiftRankOptions, SiftRankResult, SiftReport } from '../types/sift.d.ts';

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
  watchRepos: string;
  watchMinInterval: number;
  watchMaxInterval: number;
  watchDelivery: 'prompt' | 'log';
  watchIgnoreSelf: boolean;
  watchIgnoreBots: boolean;
  watchCi: CiFilter;
  watchTriage: boolean;
  watchDeferMaxAgeHours: number;
  watchStallHours: number;
  grade: boolean;
  outbound: OutboundMode;
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
  watchRepos: '',
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
  outbound: 'advise',
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
  if (!(OUTBOUND_MODES as readonly unknown[]).includes(out['outbound'])) out['outbound'] = DEFAULTS.outbound;
  return out as Options;
}

// everything the hooks share once the session is bound: what a grade reads through, and the session's own state
type Runtime = GradeHost & {
  // where the jev key came from, for the status line; never the key
  apiKeyOrigin?: KeyOrigin;
  log: DecisionLog;
  // the session's checkout, resolved per call from the session's main working tree
  session: () => Promise<Checkout>;
  // the session's watch subscriptions and their pollers; absent without the triage pack
  watches?: Watches;
  // the channels a delivery reaches its recipient by: the watch's, and what follows an outbound call once its rules are known
  mailbox: Mailbox;
  sessionId: string;
  // the lifetime of the session's watch keys and every rules cache
  storeKeys: StoreKeys;
  // whether this environment still owns the session's background work, or a reload replaced it
  tenure: Tenure;
  // the outbound gate's kept verdicts, every session's
  verdicts: Verdicts;
};

// the config option is inline json or a path, relative to the repo root
async function optionConfig($: EngineInterface, value: string, root: string): Promise<unknown> {
  const v = value.trim();
  if (!v) return undefined;
  if (v.startsWith('{')) return readConfig(v, 'option');
  const path = v.startsWith('/') ? v : `${root}/${v}`;
  if (!(await $.fs.exists(path))) throw new Error(`sift config ${path} not found`);
  return readConfig(await $.fs.read(path), path);
}

// the global config file, undefined when there is no such file
async function globalConfig($: EngineInterface, path: string | undefined): Promise<unknown> {
  if (!path || !(await $.fs.exists(path))) return undefined;
  return readConfig(await $.fs.read(path), path);
}

async function apiKeyOf($: EngineInterface, options: Options): Promise<ApiKey | undefined> {
  return resolveApiKey({
    option: options.apiKey,
    env: () => $.env.get('TYPESAFE_API_KEY'),
    settings: () => $.settings.read(),
    configDir: () => $.env.get('CLAUDE_CONFIG_DIR'),
  });
}

const WATCH_ACTIONS = ['status', 'list', 'start', 'subscribe', 'unsubscribe', 'poll', 'pause', 'resume', 'reset', 'deferred'] as const;

type WatchInput = SubscribeInput & { action?: string; id?: string };

export const register: Register = (on, rawOptions) => {
  const options = resolveOptions(rawOptions);
  let runtime: Runtime | undefined;
  const defaultFilter = (): Filter => ({ items: true, ci: options.watchCi, stall: true });

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

  // what an outbound call whose rules were still being found came to once they are known: recorded, and told to the
  // caller that made it through the mailbox. an instance a reload replaced only logs it, since its deliveries stand down
  const follow = (log: (text: string) => void, agentId: string | undefined, later: Promise<Later>, digest: string) =>
    void later.then(async (l) => {
      record('outbound', l.action, { digest: `${digest}: ${l.decision?.reason ?? l.text}` });
      const rt = runtime;
      if (rt && (await rt.tenure.holds())) await rt.mailbox.deliver({ to: agentId, text: l.text });
      else log(l.text);
    });

  // where what follows a call reaches the caller that made it
  const arrival = (agentId: string | undefined) =>
    agentId
      ? `It arrives with the result of your next tool call, or as a message that resumes you if you make none within ${GRACE_MS / 1000} s or have ended your turn.`
      : 'It arrives as a prompt in this session.';

  const ready = (): Runtime => {
    if (!runtime) throw new Error(UNBOUND);
    return runtime;
  };

  // where each subagent was spawned, its grades defaulting there, and which of sift's tools it was given
  const spawns = new Spawns();

  // sift's tools this environment has registered so far, as the model names them
  const offered: string[] = [];

  // each loop's task, what prune already dropped for it, and whether it is turned off there
  const pruneLoops = new PruneLoops();

  // file access via the engine, bound at session start
  let readFile: (p: string) => Promise<string> = async () => '';

  async function gradeIn(rt: Runtime, packName: string, ref: string, opts: GradeOptions = {}, agentId?: string): Promise<Report> {
    const { report, subject } = await grade(rt, await scopeOf(rt.checkouts, rt.session, opts.cwd, spawns.of(agentId)), packName, ref, opts);
    record('grade', report.verdict, { digest: `${packName} ${subject.ref}` });
    return report;
  }

  // $.sift as other plugins see it is declared in types/sift.d.ts: each declared type is held to the one it declares
  type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
  type Holds<T extends true> = T;
  type _Contract = [
    Holds<Same<SiftQuestion, Questions[string]>>,
    Holds<Same<SiftAnswer, Answer>>,
    Holds<Same<SiftJudgement, Judgement>>,
    Holds<Same<SiftRankOptions, RankOptions>>,
    Holds<Same<SiftRankResult<RankItem>, RankResult<RankItem>>>,
    Holds<Same<SiftGradeOptions, GradeOptions>>,
    Holds<Same<SiftReport, Report>>,
  ];

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
    const store = { get: (k: string) => $.store.get(k), set: (k: string, v: unknown) => $.store.set(k, v), delete: (k: string) => $.store.delete(k), keys: () => $.store.keys() };
    const sessionId = await $.session.id();
    const keys = sessionKeys(sessionId);
    // the environment a reload replaced lives on until its last dispatch settles: it stands down, so its timers poll
    // and deliver nothing and its writes never clobber what this one loads
    let watches: Watches | undefined;
    let mailbox: Mailbox | undefined;
    const tenure = new Tenure({
      store,
      key: keys.tenure,
      token: tenureToken(Date.now()),
      after: (ms, fn) => $.clock.after(ms, fn),
      lost: () => {
        void watches?.end();
        void mailbox?.stop();
        $.ui.log('sift: a reload replaced this instance, its watch and deliveries stand down');
      },
    });
    await tenure.claim();
    // what the session's background work writes
    const owned = tenure.store(store);
    await spawns.bind(owned, keys.agents);
    const storeKeys = new StoreKeys({ store, now: () => Date.now(), log: (text) => $.ui.log(text) });
    await storeKeys.touch(sessionId);
    await storeKeys.sweep(sessionId);
    $.clock.every(SEEN_EVERY_MS, () => void tenure.holds().then((held) => (held ? storeKeys.touch(sessionId) : undefined)));
    const log = new DecisionLog(store, sessionId);
    const apiKey = await apiKeyOf($, options);
    const inner = makeJudge(
      { backend: options.backend, apiKey: apiKey?.key, keyOrigin: apiKey?.origin, jevModel: options.jevModel, jevBaseUrl: options.jevBaseUrl, fallbackModel: options.fallbackModel },
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
    const [base] = configLayers({ option: await optionConfig($, options.config, await spawnCwd()), global: await globalConfig($, globalPath) });
    const checkouts = new Checkouts({ run, fs, forgeAt: (dir) => new GitHubForge(run, async () => dir), base: () => base });
    const session = async () => checkouts.resolve(await spawnCwd());
    const bound = await session();
    // the watch polls under the session's conventions and packs, as bound at start
    const { config, packs } = bound;
    const triagePack = packs['triage'];
    const letters = new Mailbox({
      store: owned,
      key: keys.mail,
      agents: () => $.agent.list(),
      now: () => Date.now(),
      submit: async (text) => void (await $.prompt.submit({ text })),
      send: async (to, text) => refusalOf(await $.tool.call({ tool: 'SendMessage', to, message: text, summary: 'sift watch delivery' })),
      retire: async (agentId, why) => watches?.retireOwner(agentId, why),
      schedule: (ms, fn) => tenure.after(ms, fn),
      log: (text) => $.ui.log(text),
    });
    mailbox = letters;
    watches = triagePack
      ? new Watches({
          store: owned,
          key: keys.subs,
          stateKey: keys.state,
          now: () => Date.now(),
          log: (text) => $.ui.log(text),
          status: (text) => $.ui.status(text),
          watcher: {
            forge,
            store: owned,
            judge,
            pack: triagePack,
            issuePack: packs['issue'],
            config,
            now: () => Date.now(),
            // each recipient's delivery goes by its channel: the main loop's prompt, or the owning agent's mailbox
            deliver: async (d) => {
              if (!(await tenure.holds())) return;
              if (options.watchDelivery === 'log') {
                for (const line of [...(d.to ? [`sift watch to ${d.to}:`] : []), ...d.text.split('\n')]) $.ui.log(line);
                return;
              }
              await letters.deliver(d);
            },
            log: (text) => $.ui.log(text),
            schedule: (ms, fn) => tenure.after(ms, fn),
            onDecision: (event, action, label) => log.push({ at: Date.now(), module: 'watch', backend: judge.name, ok: true, digest: `${event.id} ${event.changes.join(',')}`, action, shadow: options.shadow, answers: { label } }),
          },
          options: {
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
              triage: options.watchTriage && options.backend !== 'off',
              protectedBranches: config.branches.protected,
              branchPattern: config.branches.pattern,
            },
          },
        })
      : undefined;
    const discoveries = new Discoveries({ judge, store, now: () => Date.now(), log: (text) => $.ui.log(text), schedule: (ms, fn) => $.clock.after(ms, fn), waitMs: DISCOVERY_WAIT_MS });
    runtime = { judge, apiKeyOrigin: apiKey?.origin, log, forge, checkouts, session, fs, discoveries, watches, mailbox: letters, sessionId, storeKeys, tenure, verdicts: new Verdicts(store) };
    $.ui.log(`sift: judge ${judge.name}, repo ${bound.repo ?? 'none'}, packs ${Object.keys(bound.packs).join(' ')}`);

    // a subagent keeps the tools it was spawned with, so what it was offered is recorded as each is registered
    const tool = async (spec: Parameters<typeof $.tool.register>[0]) => {
      await $.tool.register(spec);
      offered.push(`mcp__sift__${spec.name}`);
    };

    if (options.grade) {
      await tool({
        name: 'grade',
        description:
          'Grade a repository subject with a sift pack and get mechanical findings plus calibrated judgements. Packs and what each expects as subject: issue (an issue number as N or #N, or an issue URL, which may name another repo), pr (a PR number as N or #N, a PR URL, or a range like dev..HEAD graded from the checkout before the PR exists; mechanical checks only: link, target, branch, CI, template, commit format, drift), commit (a ref such as a sha, branch or tag, or a range like main..HEAD; the commit format check only), release ("release" for the required bump alone, or a proposed version like v1.4.0; ref: the branch it is cut from, repo: any repo, no checkout needed), rules (an issue number or URL, or free text in text; a PR or commit is refused), locate (an issue number or URL, or free text in text, lists the files of the checkout to read or change for it), plan (an issue number, text: the plan, judges whether the plan covers the issue, adds nothing beyond it, and decides nothing it leaves open), triage (free text in text or the subject, a repository event: does it need the session to act on it now; the watch runs it on each event). top sets how many items every top list shows, over each pack step\'s own setting: locate\'s paths per level, and any repo-defined pack\'s top steps. Never paste a title or body as the subject: it is a reference, the text goes in text. A missing or malformed subject is refused with the expected form named. The grade reads one checkout: cwd when given (pass it from a worktree or another repository), else the directory the calling subagent was spawned in, else the session\'s repository; that checkout\'s .sift/config.json conventions and .sift/packs apply, and repo-defined packs are available by name.',
        inputSchema: {
          type: 'object',
          properties: {
            pack: { type: 'string', description: 'pack name' },
            subject: { type: 'string', description: 'what the pack grades: an issue or PR number (N or #N) or URL, a commit ref or range, "release" or a version. See the pack list for what each accepts' },
            repo: { type: 'string', description: 'owner/name, defaults to the repository of the checkout the grade reads. An issue, PR by number or plan grade for another repo reads it from the code host under that repo\'s .sift/config.json; so does a release or rules grade when cwd is not given. A commit, PR range or locate grade refuses a repo that is not its checkout\'s' },
            cwd: { type: 'string', description: 'absolute path of the directory whose checkout the grade reads: its HEAD, working tree, .sift/config.json and .sift/packs, and its repository. Defaults to the directory the calling subagent was spawned in, else the session\'s repository. Pass it when working in a worktree or another repository' },
            text: { type: 'string', description: 'free text subject for the rules and locate packs, or the plan for the plan pack' },
            ref: { type: 'string', description: 'release pack: the branch or sha the release is cut from. Defaults to HEAD in a checkout, else the configured PR target branch, else the default branch' },
            top: { type: 'number', description: 'how many items every top list shows, over each pack step\'s own setting: locate\'s paths per level (default 20) and the top steps of any repo-defined pack' },
          },
          required: ['pack', 'subject'],
        },
      });
      await tool({
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
      await tool({
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

    await tool({
      name: 'status',
      description: 'sift status: judge backend, enabled modules, the watch subscriptions and their pollers, and decision counts. Call it at session start to learn whether repository events will be delivered to you as prompts.',
      inputSchema: { type: 'object', properties: {} },
    });
    await tool({
      name: 'watch',
      description:
        'Control the sift watch, a set of subscriptions polled one repository at a time. subscribe (repo, default the one checked out where the calling subagent was spawned, else the session\'s; scope: repo, pr <n>, branch <name>, run <id> or tag <glob>; items, ci, stall filter what reaches you; until: settled, merged, closed or an iso time; returns the id), unsubscribe (id), list (every subscription with its scope, filter and owner), start (subscribe to that repository with the configured filter, or to one pull request or branch when for names it, until settled from a subagent), status, poll (one poll now), pause, resume, reset (forget the cursor and reseed), deferred (events held back). poll, pause, resume, reset and deferred act on every polled repository, or on repo alone. A subscription made from a subagent belongs to it and outlives its turn: subscribe, end your turn, and the delivery resumes you. It arrives with your next tool call, or as a message after 60 s without one or once you have ended your turn. Do not wait or poll for it. It is removed by until, unsubscribe, or once no message can reach you.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...WATCH_ACTIONS] },
          repo: { type: 'string', description: 'owner/name. subscribe and start: the repository, default the one checked out where the calling subagent was spawned, else the session\'s. poll, pause, resume, reset, deferred: only this repository' },
          scope: { type: 'string', description: 'subscribe: repo (default), pr <n> (the pull request across its heads), branch <name> (its runs), run <id> (that run, read by id until it completes), tag <glob> (runs on tags matching the glob)' },
          items: { type: 'boolean', description: 'subscribe: deliver issue and pull request events in scope, default true' },
          ci: { type: 'string', enum: [...CI_FILTERS], description: 'subscribe: settled (each pull request head\'s verdict, and each completed run on a branch, tag or run scope), failures (verdicts and failed runs), all (every completed run as well), none. Default the watchCi option' },
          stall: { type: 'boolean', description: 'subscribe: deliver a pull request head whose checks stall, default true' },
          until: { type: 'string', description: 'subscribe: settled (after its first verdict or completed run is delivered), merged or closed (pr scope), or an iso time; the subscription is removed once reached' },
          id: { type: 'string', description: 'unsubscribe: the subscription id' },
          for: { type: 'string', description: 'start only: the pull request to follow, its number or head branch, instead of the whole repository. From a subagent it lasts until settled unless until says otherwise' },
        },
      },
    });
    if (options.prune) {
      await tool({
        name: 'prune',
        description:
          'Turn sift\'s pruning of long Bash and Read output off or on for the calling loop alone (this subagent, or the main loop). off lasts until the loop\'s next task (a subagent\'s whole run), or for the next calls outputs prune would otherwise judge; on turns it back on. Call off before reading a document in full when every line matters. For one Bash command, end it with # sift: full instead. A Read with offset or limit, a repeat of a Read or command that was pruned, and a Read of a path your task names are never pruned. A Read is only ever cut at its tail, so its line numbers stay true.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['off', 'on'] },
            calls: { type: 'number', description: 'off only: how many outputs over the floor stay whole, default until the loop\'s next task' },
          },
          required: ['action'],
        },
      });
    }
    await tool({
      name: 'post',
      description:
        `Write an issue, pull request, comment, review, merge or release on ${forge.name} to the repository named in repo, never the one the working directory implies. What happens to its text follows the outbound mode. Under advise, the default, the text is judged against that repository's rule documents and its outbound channels, the write is made whatever the verdict, and the url is returned with the verdict. Under enforce a broken rule or a channel's length limit refuses the write with the rule quoted and nothing is written, unless override gives the reason it goes through as written. Under off the write is made unjudged. While the rules of the repository are still being found, advise writes at once and the advice follows, and enforce answers held and judges and writes the post once they are known, the url or the refusal following; what follows arrives with a later tool call or as a message, so never make the same post again. Every kind takes repo and kind. issue-create: title, body. pr-create: title, body, base, head (a branch, or owner:branch from a fork), draft. issue-comment, pr-comment: number, body. issue-edit, pr-edit: number, title or body or both. pr-review: number, verdict, body (required unless approving). pr-merge: number, method, title and body for the merge commit. release-create: tag, body (the notes), title, target, draft, prerelease. release-edit: tag, title or body. Writing these through gh in Bash is refused under enforce; labels, assignees, closing and the like stay with gh.`,
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'the repository written to, as owner/name' },
          kind: { type: 'string', enum: forge.writes.map(postKind), description: 'the artifact and what the write does to it' },
          number: { type: 'number', description: 'the issue or pull request number, for comment, edit, review and merge' },
          tag: { type: 'string', description: 'release-create and release-edit: the release tag' },
          title: { type: 'string', description: 'the title; for pr-merge the merge commit subject' },
          body: { type: 'string', description: 'the body, comment, review, release notes, or for pr-merge the merge commit message' },
          base: { type: 'string', description: 'pr-create: the branch merged into' },
          head: { type: 'string', description: 'pr-create: the branch merged from' },
          draft: { type: 'boolean', description: 'pr-create and release-create: open as a draft' },
          verdict: { type: 'string', enum: [...VERDICTS], description: 'pr-review: the review verdict' },
          method: { type: 'string', enum: [...METHODS], description: 'pr-merge: how the pull request is merged' },
          target: { type: 'string', description: 'release-create: the branch or sha the tag is created from when it does not exist' },
          prerelease: { type: 'boolean', description: 'release-create: mark the release a prerelease' },
          override: { type: 'string', description: 'under enforce: the reason this write goes through although the judge refuses it. The decision log records it with the ruling and the text' },
        },
        required: ['repo', 'kind'],
      },
    });
    await $.command.register({ name: 'sift', description: 'sift status, log, prune and watch control', argumentHint: '[status|log|clear|prune off [n]|prune on|watch status|list|poll|pause|resume|reset|deferred [repo]|start [repo] [for <pr|branch>]|subscribe <repo> [scope]|unsubscribe <id>]' });

    await letters.load();
    const watchRepos = options.watchRepos.split(',').map((r) => r.trim()).filter(Boolean);
    // the rules a post and the gate read are found in the background before the first write needs them: the bound
    // repository's and each watched one's on the forge, and the bound checkout's own
    if (options.outbound !== 'off' && options.backend !== 'off' && bound.packs['rules']) {
      const warm = (scope: string, found: Promise<unknown>) => void found.catch((error: unknown) => $.ui.log(`sift rules ${scope}: discovery at start failed (${messageOf(error)})`));
      for (const repo of new Set([...(bound.repo ? [bound.repo] : []), ...watchRepos])) warm(repo, checkouts.remoteConfig(forge, repo).then((c) => discoveries.settle(forgeSource(forge, repo), c.rules)));
      if (bound.git) warm(bound.root, discoveries.settle(ruleSource({ forge, fs }, { checkout: bound, named: false }, bound.repo), bound.config.rules));
    }
    if (watches) {
      await watches.load();
      if (options.watch) {
        const repos = [...watchRepos];
        if (repos.length === 0 && bound.repo) repos.push(bound.repo);
        if (repos.length === 0) $.ui.log(`sift watch: no repository to watch (set watchRepos or run in a checkout with a ${forge.name} remote)`);
        for (const repo of repos) await watches.subscribe({ repo, scope: { kind: 'repo' }, filter: defaultFilter() });
      }
    } else if (options.watch) {
      $.ui.log('sift watch: triage pack missing');
    }
    return next(e);
  });

  // the session's watch keys go with it. clear and resume leave the process running under the id bound at start, so
  // its keys stay in use
  on('classic.SessionEnd', async (_$, e, next) => {
    if (runtime && e.reason !== 'clear' && e.reason !== 'resume') {
      const rt = runtime;
      await rt.watches?.end();
      await rt.mailbox?.stop();
      await rt.storeKeys.end(rt.sessionId);
    }
    return next(e);
  });

  // registered first, so outermost over every tool. a delivery waiting for a subagent rides the result of its next
  // tool call, whichever tool and whichever hook answers it; beneath that, outbound gate before, prune after
  on('tool.call', async ($, e, next) => {
    const answer = async (): Promise<Awaited<ReturnType<typeof next>>> => {
      if (e.tool.startsWith('mcp__sift__')) return next(e);
      const rt = runtime;
      const command = (e as unknown as { command?: unknown }).command;
      const mode = options.outbound;
      const shell = mode !== 'off' && e.tool === 'Bash' && typeof command === 'string' ? command : undefined;
      // a reload's new environment answers before its session start has bound it: an enforced forge write waits for
      // the gate, read by the cli of the forge session start binds
      if (!rt) {
        const early = mode === 'enforce' && shell !== undefined ? rawWriteOf({ writeOf: ghWriteOf }, shell) : undefined;
        return early ? { deny: `sift outbound: ${UNBOUND}, so this ${postKind(early)} write from the shell cannot be judged yet. Run the command again in a moment.` } : next(e);
      }
      // the checkout a grade with no cwd reads: where this loop was spawned, else the session's
      const checkoutOf = async () => (await scopeOf(rt.checkouts, rt.session, undefined, spawns.of(e.agentId))).checkout;
      // verdicts an advised call carries back beside its result
      const notes: string[] = [];
      // a pending decision's verdict, told to this caller under head once the rules are known. sift does not make
      // this call itself, so it is never held: under advise it runs now, under enforce it is refused now
      const later = ({ checkout, outbound, decision }: Gated, head: string) => {
        const again = async () => {
          const gated = await gateText(rt, checkout, outbound);
          if (!gated) throw new Error(`the checkout ${checkout.root} has no rules pack`);
          return gated.decision;
        };
        if (mode !== 'off') follow((text) => $.ui.log(text), e.agentId, verdictLater(mode, outbound, decision, again, head), outbound.channel);
      };
      // a verdict at once, or when the rules are still being found, a note that it follows once they are known
      const advised = (gated: Gated) => {
        const { checkout, outbound, decision } = gated;
        if (!decision.pending) return void notes.push(verdictOf(outbound, decision));
        later(gated, `sift outbound advice on the ${outbound.channel} text of this ${e.tool} call, now that its rules are known`);
        notes.push(`${pendingNote(outbound, checkout.repo ?? checkout.root)}. ${arrival(e.agentId)}`);
      };
      // an enforced refusal; while the rules are still being found the call is refused unjudged, and the verdict it
      // would meet follows once they are known, for the caller to run it again then
      const refusal = (gated: Gated, then: string) => {
        const { checkout, outbound, decision } = gated;
        if (!decision.pending) return `sift outbound (${outbound.channel}): ${decision.reason}. ${then}`;
        const scope = checkout.repo ?? checkout.root;
        later(gated, `sift outbound: the rules of ${scope} are known, and this is the verdict the ${outbound.channel} text of the ${e.tool} call refused while they were found would meet. Run that call again, rewritten if it breaks a rule`);
        return `sift outbound (${outbound.channel}): the rules of ${scope} are still being found, so this call is refused unjudged. The verdict on its text follows once they are known. ${arrival(e.agentId)} Run the call again then.`;
      };
      // a forge write from the shell goes through post under enforce, which names its destination; a loop without
      // post, and every loop under advise, has its text judged
      const raw = shell !== undefined ? rawWriteOf(rt.forge, shell) : undefined;
      if (raw && mode !== 'off') {
        const gate = await gateShellWrite(rt, raw, spawns.has(e.agentId, POST_TOOL), mode, checkoutOf, e as unknown as Record<string, unknown>, readFile);
        const without = gate.fallback ? ' without post' : '';
        if ('refused' in gate) {
          record('outbound', options.shadow ? 'would-refuse' : 'refuse', { digest: `shell ${postKind(raw)}${without}` });
          if (options.shadow) $.ui.log(`sift outbound (shadow): would refuse: ${gate.refused}`);
          else return { deny: `sift outbound: ${gate.refused}.` };
        } else if (gate.unread !== undefined) {
          record('outbound', options.shadow ? 'would-advise' : 'advise', { digest: `shell ${postKind(raw)}${without}: text not read` });
          if (!options.shadow) notes.push(gate.unread);
        } else if (gate.gated) {
          const { outbound, decision } = gate.gated;
          const done = enact(mode, decision, options.shadow);
          record('outbound', done.action, { digest: `${outbound.channel}${without} ${outbound.text.length} chars: ${decision.reason}` });
          for (const w of decision.warnings) $.ui.log(`sift outbound (${outbound.channel}): ${w}`);
          if (done.refuse) return { deny: refusal(gate.gated, `${fallbackNote(rt.forge)}. Rewrite the text or ask the user.`) };
          if (!decision.allow && options.shadow) $.ui.log(`sift outbound (shadow): would ${mode === 'enforce' ? 'deny' : 'advise on'} ${outbound.channel} text: ${decision.reason}`);
          if (done.advise) advised(gate.gated);
        }
      }
      const checkout = mode !== 'off' && !raw ? await checkoutOf() : undefined;
      const gated = checkout ? await gateCall(rt, checkout, e.tool, e as unknown as Record<string, unknown>, readFile) : undefined;
      if (gated) {
        const { outbound, decision } = gated;
        const done = enact(mode, decision, options.shadow);
        record('outbound', done.action, { digest: `${outbound.channel} ${outbound.text.length} chars: ${decision.reason}` });
        for (const w of decision.warnings) $.ui.log(`sift outbound (${outbound.channel}): ${w}`);
        if (done.refuse) return { deny: refusal(gated, 'Rewrite the text or ask the user.') };
        if (!decision.allow && options.shadow) $.ui.log(`sift outbound (shadow): would ${mode === 'enforce' ? 'deny' : 'advise on'} ${outbound.channel} text: ${decision.reason}`);
        if (done.advise) advised(gated);
      }
      const r = await next(e);
      const pruned: Awaited<ReturnType<typeof next>> = !options.prune
        ? r
        : await pruneCall(
            { tool: e.tool, input: e as unknown as Record<string, unknown>, agentId: e.agentId },
            r,
            pruneLoops,
            rt.judge,
            { ...PRUNE_DEFAULTS, floorTokens: options.pruneFloorTokens, chunkLines: options.pruneChunkLines, keepThreshold: options.pruneKeepThreshold, tools: pruneTools(options), shadow: options.shadow },
            { record: (action, extra) => record('prune', action, extra), toast: (text) => $.ui.toast(text) },
          );
      if (notes.length === 0 || pruned.deny !== undefined) return pruned;
      return { ...pruned, context: [...(pruned.context ?? []), ...notes] };
    };
    const r = await answer();
    const rt = runtime;
    const mailbox = rt?.mailbox;
    // an instance a reload replaced while this call ran has only stale letters; the one that replaced it delivers
    if (!e.agentId || !rt || !mailbox || r.deny !== undefined || !(await rt.tenure.holds())) return r;
    const letters = await mailbox.take(e.agentId);
    return letters.length === 0 ? r : { ...r, context: [...(r.context ?? []), ...letters] };
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

  // the destination is the repo the call names; the rules pack is the caller's, as a grade's is
  on('tool.call', { tool: POST_TOOL }, async ($, e) => {
    try {
      const rt = ready();
      const pack = (await scopeOf(rt.checkouts, rt.session, undefined, spawns.of(e.agentId))).checkout.packs['rules'];
      const input = e as unknown as PostInput;
      const posted = await postCall({ forge: rt.forge, judge: rt.judge, discoveries: rt.discoveries, verdicts: rt.verdicts, config: (repo) => rt.checkouts.remoteConfig(rt.forge, repo) }, pack, input, options.outbound, options.shadow);
      const { outbound, decision, action } = posted;
      if (outbound && decision && action) {
        const override = posted.override !== undefined ? { override: posted.override, reason: decision.reason, text: outbound.text } : {};
        record('outbound', action, { digest: `${outbound.channel} ${String(input.repo)} ${outbound.text.length} chars: ${decision.reason}`, ...override });
        for (const w of decision.warnings) $.ui.log(`sift outbound (${outbound.channel}): ${w}`);
        if (!decision.allow && options.shadow) $.ui.log(`sift outbound (shadow): would ${options.outbound === 'enforce' ? 'deny' : 'advise on'} ${outbound.channel} text: ${decision.reason}`);
      }
      if (posted.later) follow((text) => $.ui.log(text), e.agentId, posted.later, `${outbound?.channel} ${String(input.repo)}`);
      if ('refused' in posted) return { deny: `sift post refused: ${posted.refused}. ${decision ? 'Rewrite the text, or post again with override set to the reason it should go through as written.' : 'Fix the input and post again.'}` };
      if ('held' in posted) return { result: [{ type: 'text', text: `held: ${posted.held} ${arrival(e.agentId)} Do not post it again.` }] };
      if (posted.verdict !== undefined) return { result: [{ type: 'text', text: `${posted.url}\n${posted.verdict}${posted.later ? `. ${arrival(e.agentId)}` : ''}` }] };
      return { result: [{ type: 'text', text: posted.url }] };
    } catch (error) {
      return { deny: `sift post failed: ${messageOf(error)}` };
    }
  });

  on('agent.spawn', async (_$, e, next) => {
    const r = await next(e);
    await spawns.spawned(r.agentId, e.cwd, e.parentAgentId, offered);
    pruneLoops.spawned(r.agentId, e.prompt);
    return r;
  });

  on('tool.call', { tool: 'mcp__sift__judge' }, async ($, e) => {
    const input = e as unknown as { state: unknown; questions: Questions };
    const rt = runtime;
    if (!rt) return { deny: `sift judge: ${UNBOUND}. Call it again in a moment.` };
    const result = await rt.judge.ask(input.state, input.questions);
    record('judge-tool', result.ok ? 'answered' : 'failed');
    const text = result.ok
      ? Object.entries(result.answers).map(([id, a]) => `${id}: ${answerLabel(a)}`).join('\n')
      : `judge unavailable: ${failureText(result)}`;
    return result.ok ? { result: [{ type: 'text', text }] } : { deny: text };
  });

  on('tool.call', { tool: 'mcp__sift__rank' }, async ($, e) => {
    const input = e as unknown as { items: RankItem[]; questions: Questions; mode?: RankOptions['mode']; context?: Record<string, unknown>; by?: string; choice?: string; fields?: string[] };
    const rt = runtime;
    if (!rt) return { deny: `sift rank: ${UNBOUND}. Call it again in a moment.` };
    const result = await rank(input.items, input.questions, rt.judge, { mode: input.mode ?? 'batched', context: input.context, by: input.by, choice: input.choice, fields: input.fields });
    record('rank-tool', result.ok ? 'ranked' : 'failed', { digest: `${input.items.length} items, ${result.requests} requests` });
    if (!result.ok) return { deny: `rank unavailable: ${failureText(result)}` };
    const lines = result.sorted.map((r) => `${r.index}: ${r.value.toFixed(3)} ${Object.entries(r.answers).map(([id, a]) => `${id}=${answerLabel(a)}`).join(' ')} ${digestOf(r.item)}`);
    return { result: [{ type: 'text', text: [`${result.items.length} items in ${result.requests} request${result.requests === 1 ? '' : 's'}, sorted by ${input.by ?? Object.keys(input.questions)[0]}`, ...lines].join('\n') }] };
  });

  // a person's prompt is the main loop's task for prune, save /sift itself, which controls sift and is no task.
  // a module that fell back since the last prompt says so once, beside the prompt, instead of hiding in a count
  on('prompt.submit', async (_$, e, next) => {
    if (!/^\/sift(\s|$)/.test(e.text.trim())) pruneLoops.submitted(e.origin.kind, e.text);
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
          (s.tokensRemoved ? `  removed ${k(s.tokensRemoved)}` : '') +
          (m === 'outbound' ? `  advised ${s.actions['advise'] ?? 0}  denied ${(s.actions['deny'] ?? 0) + (s.actions['refuse'] ?? 0)}  overridden ${s.actions['override'] ?? 0}` : ''),
      )
      .join('\n');
    const cost = (c: Cost) => `judge in ${k(c.requestTokens)}, out ${k(c.responseTokens)}, context removed ${k(c.tokensRemoved)}`;
    const enabled = (Object.keys(options) as (keyof Options)[]).filter((k) => typeof options[k] === 'boolean' && options[k]).join(', ');
    const last = stats.session.lastFailure;
    const repo = (await rt.session()).repo;
    const watch = watchSummary(rt);
    return [
      `sift: judge ${rt.judge.name}${options.shadow ? ' (shadow mode)' : ''}, repo ${repo ?? 'none'}`,
      judgeLine(rt.judge.name, rt.apiKeyOrigin, rt.judge.keyRejected),
      `enabled: ${enabled}; outbound ${options.outbound}`,
      watch,
      `this session: ${stats.session.calls} decisions, ${stats.session.failures} failures${last ? ` (last ${last.module} at ${new Date(last.at).toISOString()}: ${last.backend}: ${last.reason ?? 'no reason'})` : ''}`,
      `all sessions (ring of 500): ${stats.calls} decisions, ${stats.failures} failures`,
      `cost this session: ${cost(stats.session.cost)}; ring: ${cost(stats.cost)} (tokens, estimated unless the backend reports them)`,
      modules || '  no decisions yet',
    ].join('\n');
  }

  function watchSummary(rt: Runtime): string {
    const w = rt.watches;
    if (!w || w.list().length === 0) return 'watch: off';
    const repos = w.repos().map((repo) => {
      const st = w.poller(repo)?.snapshot();
      const state = !st ? 'not polled' : `${st.paused ? 'paused' : 'running'}, ${st.deferred.length} deferred, last poll ${st.lastPoll ? new Date(st.lastPoll).toISOString() : 'never'}`;
      return `  ${repo}: ${state}`;
    });
    const waiting = (rt.mailbox?.pending() ?? []).map((p) => `  waiting for ${p.to}'s next tool call: ${p.count} deliver${p.count === 1 ? 'y' : 'ies'}`);
    return [`watch: ${w.list().length} subscription${w.list().length === 1 ? '' : 's'} on ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`, ...repos, ...w.list().map((s) => `  ${formatSubscription(s)}`), ...waiting].join('\n');
  }

  // the watch controls, shared by /sift watch and the watch tool. owner is the agentId of the subagent the call runs
  // in, if any: what it subscribes belongs to it, on the repository of the checkout it was spawned in unless it names one
  async function watchControl(rt: Runtime, input: WatchInput, owner?: string): Promise<string> {
    const w = rt.watches;
    if (!w) return 'watch unavailable: triage pack missing';
    const sub = input.action ?? 'status';
    if (sub === 'list') return w.list().map(formatSubscription).join('\n') || 'no subscriptions';
    if (sub === 'start' || sub === 'subscribe') {
      const checkout = await scopeOf(rt.checkouts, rt.session, undefined, spawns.of(owner)).then((s) => s.checkout, (error: unknown) => ({ error: messageOf(error) }));
      if ('error' in checkout) return `watch cannot subscribe: ${checkout.error}`;
      const wanted = subscriptionOf(input, { start: sub === 'start', repo: checkout.repo, filter: defaultFilter(), owner });
      if ('error' in wanted) return `watch cannot subscribe: ${wanted.error}`;
      const { sub: made, added } = await w.subscribe(wanted);
      return [`${added ? 'subscribed' : 'already subscribed'}: ${formatSubscription(made)}`, ...(owner ? [ownerNotice(owner)] : [])].join('\n');
    }
    if (sub === 'unsubscribe') {
      const id = input.id?.trim();
      if (!id) return 'watch unsubscribe needs an id (see watch list)';
      return (await w.unsubscribe(id)) ? `unsubscribed ${id}` : `no subscription ${id}`;
    }
    const repos = input.repo?.trim() ? [input.repo.trim()] : w.repos();
    const pollers = repos.flatMap((r) => w.poller(r) ?? []);
    if (pollers.length === 0) return input.repo ? `no subscription on ${input.repo}` : 'watch is off (subscribe, start, or set the watch option to subscribe at boot)';
    for (const p of pollers) {
      if (sub === 'pause') await p.pause();
      else if (sub === 'resume') await p.resume();
      else if (sub === 'reset') await p.reset();
      else if (sub === 'poll') await p.tick();
    }
    if (sub === 'deferred') {
      const lines = repos.flatMap((r) => (w.poller(r)?.snapshot().deferred ?? []).map((d) => `${r} ${d.reason.padEnd(24)} ${d.event.kind} ${d.event.number ?? ''} ${d.event.title} ${d.label ?? ''} (${d.subs.join(', ')})`));
      return lines.join('\n') || 'nothing deferred';
    }
    return repos
      .flatMap((r) => {
        const st = w.poller(r)?.snapshot();
        if (!st) return [];
        return [
          `watch ${r}: ${st.paused ? 'paused' : 'running'}, ${Object.keys(st.items).length} items, ${Object.keys(st.runs).length} runs cached, ${w.on(r).length} subscriptions`,
          `  interval ${Math.round(st.interval / 1000)}s, last poll ${st.lastPoll ? new Date(st.lastPoll).toISOString() : 'never'}, failures ${st.failures}`,
          `  deferred ${st.deferred.length}, self login ${st.login ?? 'unknown'}, cursor ${st.cursor}`,
        ];
      })
      .join('\n');
  }

  on('tool.call', { tool: 'mcp__sift__watch' }, async ($, e) => {
    const rt = runtime;
    const input = e as unknown as WatchInput;
    const action = String(input.action ?? 'status');
    if (!rt) return { deny: `sift watch: ${UNBOUND}. Call it again in a moment.` };
    if (!(WATCH_ACTIONS as readonly string[]).includes(action)) return { deny: `unknown watch action ${action}` };
    try {
      return { result: [{ type: 'text', text: await watchControl(rt, { ...input, action }, e.agentId) }] };
    } catch (error) {
      return { deny: `sift watch ${action} failed: ${messageOf(error)}` };
    }
  });

  on('tool.call', { tool: PRUNE_TOOL }, async ($, e) => {
    const input = e as unknown as { action?: string; calls?: number };
    if (input.action !== 'off' && input.action !== 'on') return { deny: `prune takes action off or on, not ${String(input.action)}` };
    const text = pruneLoops.control(e.agentId, input.action, input.calls);
    record('prune', `turned-${input.action}`, { digest: `${e.agentId ?? 'main'}: ${text}` });
    return { result: [{ type: 'text', text }] };
  });

  on('tool.call', { tool: 'mcp__sift__status' }, async () => {
    const rt = runtime;
    return { result: [{ type: 'text', text: rt ? await statusText(rt) : UNBOUND }] };
  });

  on('command.run', { command: 'sift' }, async ($, e) => {
    const rt = runtime;
    if (!rt) return { text: UNBOUND };
    const [head = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean);
    if (head === 'log') {
      const n = Number(rest[0]) || 30;
      const lines = (await rt.log.recent(n)).map((d) => `${new Date(d.at).toISOString().slice(11, 19)} ${d.module.padEnd(8)} ${d.action.padEnd(12)} ${d.digest}${d.answers ? ' ' + JSON.stringify(d.answers) : ''}${d.reason ? ' ' + d.reason : ''}`);
      return { text: lines.join('\n') || 'no decisions yet' };
    }
    if (head === 'clear') {
      await rt.log.clear();
      await rt.verdicts.clear();
      return { text: 'decision log and kept outbound verdicts cleared' };
    }
    if (head === 'prune') {
      const [action, n] = rest;
      if (action !== 'off' && action !== 'on') return { text: 'usage: /sift prune off [n] | on' };
      const text = pruneLoops.control(undefined, action, n === undefined ? undefined : Number(n));
      record('prune', `turned-${action}`, { digest: `main: ${text}` });
      return { text };
    }
    if (head === 'watch') {
      const [action = 'status', ...args] = rest;
      if (!(WATCH_ACTIONS as readonly string[]).includes(action)) return { text: `unknown watch action ${action}` };
      const input = commandInputOf(action, args);
      if ('error' in input) return { text: input.error };
      return { text: await watchControl(rt, input) };
    }
    return { text: `${await statusText(rt)}\ncommands: /sift log [n], /sift clear, /sift prune off [n]|on, /sift watch status|list|poll|pause|resume|reset|deferred [repo], /sift watch start [repo] [for <pr|branch>], /sift watch subscribe <repo> [scope], /sift watch unsubscribe <id>` };
  });
};

// what a call answered by an environment whose session start has not run yet is told
const UNBOUND = 'sift is starting or reloading and not bound to the session yet';

function pruneTools(options: Options): string[] {
  return options.pruneTools.split(',').map((t) => t.trim()).filter(Boolean);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function answerLabel(a: Answer): string {
  return a.type === 'noul' ? a.p.toFixed(3) : a.type === 'choice' ? `${a.choice} (confidence ${a.confidence.toFixed(2)})` : `${a.legend} (confidence ${a.confidence.toFixed(2)})`;
}
