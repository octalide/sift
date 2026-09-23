import type { Forge } from './forge/forge.ts';
import type { Git } from './forge/git.ts';
import type { Judge } from './judge/types.ts';
import { indexTree, treeSubject } from './locate/tree.ts';
import { REMOVED_PACKS } from './packs/builtin.ts';
import { runParts } from './packs/run.ts';
import { parseSubject, refusal, type ParsedKind } from './packs/subject.ts';
import type { Pack, Report, Subject } from './packs/types.ts';
import type { Checkout, CheckoutFs, Checkouts } from './repo/checkout.ts';
import { defaultTarget, type RepoConfig } from './repo/config.ts';
import { localSource, remoteSource } from './repo/source.ts';
import { commitSubject, issueSubject, planSubject, prRangeSubject, prSubject, releaseSubject, rulesSubjects, textRulesSubjects, textSubject } from './repo/subjects.ts';
import { checkoutSource, forgeSource, type Discoveries, type RuleSource } from './rules/discover.ts';
import { truncate } from './tokens.ts';

export type GradeOptions = {
  repo?: string;
  // the directory whose checkout the grade reads, absolute; the calling agent's or the session's when unset
  cwd?: string;
  text?: string;
  ref?: string;
  top?: number;
};

export type GradeHost = {
  forge: Forge;
  judge: Judge;
  // the rule discoveries in flight, shared by every grade and post of the session
  discoveries: Discoveries;
  fs: CheckoutFs;
  checkouts: Checkouts;
};

// what one grade reads: the checkout it is bound to, and whether the caller named it
export type GradeScope = { checkout: Checkout; named: boolean };

// subject is the one graded, its opening when it was graded in parts
export type Graded = { report: Report; subject: Subject };

export async function grade(host: GradeHost, scope: GradeScope, packName: string, ref: string, opts: GradeOptions = {}): Promise<Graded> {
  const pack = scope.checkout.packs[packName];
  if (!pack) {
    const removed = REMOVED_PACKS[packName];
    if (removed) throw new Error(removed(host.forge, opts.repo ?? scope.checkout.repo ?? '<owner/name>'));
    throw new Error(`unknown pack ${packName} (have: ${Object.keys(scope.checkout.packs).join(', ')})`);
  }
  const { subjects, config } = await subjectFor(host, scope, pack, ref, opts);
  const report = await runParts(pack, subjects, host.judge, config, { top: opts.top });
  return { report, subject: subjects[0]! };
}

// the subject a pack grades, one per part when it is too long to judge at once, and the conventions of the repository it is in;
// a refusal names the pack by the name it was asked for
export async function subjectFor(host: GradeHost, scope: GradeScope, pack: Pick<Pack, 'name' | 'subject'>, ref: string, opts: GradeOptions = {}): Promise<{ subjects: Subject[]; config: RepoConfig }> {
  const { forge } = host;
  const { checkout } = scope;
  const repo = opts.repo ?? checkout.repo;
  const needRepo = () => {
    if (!repo) throw new Error(`no repository: pass repo as the ${forge.name} path or run inside a checkout with a ${forge.name} remote`);
    return repo;
  };
  // a subject in the checkout's repository takes the checkout's conventions; any other, that repository's from the forge
  const configOf = async (at: string | undefined): Promise<RepoConfig> => (at === undefined || at === checkout.repo ? checkout.config : host.checkouts.remoteConfig(forge, at));
  // the subjects that read the checkout refuse a repo that is not the checkout's, rather than mix the two
  const local = (what: string): { git: Git; root: string } => {
    if (opts.repo !== undefined && opts.repo !== checkout.repo) {
      throw new Error(`${what} reads the checkout at ${checkout.root}, which is ${checkout.repo ?? 'not a checkout of any repository'}, but repo is ${opts.repo}: pass the cwd of a checkout of ${opts.repo}, or drop repo`);
    }
    if (!checkout.git) throw new Error(`${what} reads the checkout, and ${checkout.root} is not in a git checkout: pass cwd`);
    return { git: checkout.git, root: checkout.root };
  };
  // release and rules read the checkout when it serves the repo; a named cwd always does, else another repo comes from the forge
  const readsCheckout = () => checkout.git !== undefined && (scope.named || opts.repo === undefined || opts.repo === checkout.repo);
  // the subject is parsed, and a bad one refused, before any forge request; a url names its own repo
  const parsed = <K extends ParsedKind>(kind: K) => parseSubject({ pack: pack.name, kind }, ref, forge, opts.repo);
  switch (pack.subject) {
    case 'issue': {
      const p = parsed('issue');
      const at = p.repo ?? needRepo();
      const config = await configOf(at);
      return { subjects: [await issueSubject(forge, at, p.number, config, { pack: pack.name, kind: 'issue' })], config };
    }
    case 'pr': {
      const p = parsed('pr');
      // base..head in the checkout is the pr the range would open, graded before it exists
      if ('range' in p) {
        const { git } = local('a pr range');
        return { subjects: [await prRangeSubject(git, p.range, checkout.config, checkout.repo ? { forge, repo: checkout.repo } : undefined)], config: checkout.config };
      }
      const at = p.repo ?? needRepo();
      const config = await configOf(at);
      return { subjects: [await prSubject(forge, at, p.number, config)], config };
    }
    case 'commit': {
      const p = parsed('commit');
      const { git } = local('a commit');
      return { subjects: [await commitSubject(git, p.ref, checkout.config)], config: checkout.config };
    }
    case 'release': {
      const p = parsed('release');
      let subject: Subject;
      let config: RepoConfig;
      if (readsCheckout()) {
        const { git, root } = local('a release');
        config = checkout.config;
        // the working tree stands in for HEAD, read under the checkout's root
        subject = await releaseSubject(localSource(git, opts.ref ?? 'HEAD', (f) => host.fs.read(`${root}/${f}`), (f) => host.fs.exists(`${root}/${f}`)), config);
      } else {
        const at = needRepo();
        config = await configOf(at);
        subject = await releaseSubject(remoteSource(forge, at, opts.ref ?? defaultTarget(config) ?? (await forge.defaultBranch(at))), config);
      }
      if (p.proposed !== undefined) subject.facts['proposed'] = p.proposed;
      return { subjects: [subject], config };
    }
    case 'rules': {
      // an issue by number or url, or free text: text when given, else the subject itself
      const p = parsed('rules').subject;
      let at: string | undefined;
      if (readsCheckout()) {
        local('rules');
        at = checkout.repo;
      } else at = needRepo();
      const config = await configOf(at);
      const rules = { forge, repo, source: ruleSource(host, scope, at), discoveries: host.discoveries };
      // free text is read the way the outbound gate reads it, every part of a long text judged
      if (p.kind === 'text') return { subjects: await textRulesSubjects(rules, { text: opts.text ?? p.text }, config), config };
      return { subjects: await rulesSubjects({ ...rules, repo: p.repo ?? needRepo() }, { number: p.number, pack: pack.name }, config), config };
    }
    case 'tree': {
      // text is the subject when given; otherwise an issue or pull request is its title and body, anything else the text itself
      const p = opts.text === undefined ? parsed('mixed').subject : { kind: 'text' as const, text: opts.text };
      const { git, root } = local('locate');
      let text: string;
      let label: string;
      if (p.kind === 'text' || p.kind === 'commit') {
        text = p.kind === 'text' ? p.text : p.ref;
        label = truncate(text, 40);
      } else {
        const at = p.repo ?? needRepo();
        const item = p.kind === 'issue' ? await forge.issue(at, p.number) : await forge.pull(at, p.number);
        if (p.kind === 'issue' && item.pr) throw refusal({ pack: pack.name, kind: 'mixed' }, `#${p.number}`, `subject is ${at}#${p.number}, a pull request, not an issue`, forge);
        text = `${item.title}\n\n${item.body}`;
        label = `${at}#${p.number}`;
      }
      // the tree is the checkout's, whichever repository the issue is in
      const index = await indexTree({
        list: async () => (await git(['ls-files', '-z'])).split('\0'),
        size: async (f) => (await host.fs.stat(`${root}/${f}`)).size,
        read: (f) => host.fs.read(`${root}/${f}`),
      });
      return { subjects: [treeSubject(text, label, index)], config: checkout.config };
    }
    case 'plan': {
      if (opts.text === undefined) throw new Error(`${pack.name} pack: no plan; the pack reads the plan from text: grade(pack: "${pack.name}", subject: "<issue number>", text: "<plan>")`);
      const p = parsed('issue');
      const at = p.repo ?? needRepo();
      return { subjects: [await planSubject(forge, at, p.number, opts.text, pack.name)], config: await configOf(at) };
    }
    default:
      return { subjects: [textSubject(opts.text ?? ref)], config: checkout.config };
  }
}

// the checkout serves its own repo; any other repo, or no checkout at all, is read from the forge
export function ruleSource(host: Pick<GradeHost, 'forge' | 'fs'>, scope: GradeScope, repo: string | undefined): RuleSource {
  const { checkout } = scope;
  if (checkout.git && (repo === undefined || repo === checkout.repo)) return checkoutSource(checkout.root, checkout.git, host.fs, host.forge);
  if (!repo) throw new Error(`no repository: pass repo as the ${host.forge.name} path or run inside a checkout with a ${host.forge.name} remote`);
  return forgeSource(host.forge, repo);
}

// a named cwd, else the calling subagent's spawn directory, else the session's checkout
export async function scopeOf(checkouts: Pick<Checkouts, 'resolve'>, session: () => Promise<Checkout>, cwd: string | undefined, spawnDir: string | undefined): Promise<GradeScope> {
  if (cwd !== undefined) return { checkout: await checkouts.resolve(cwd), named: true };
  return { checkout: spawnDir === undefined ? await session() : await checkouts.resolve(spawnDir), named: false };
}
