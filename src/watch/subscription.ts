import type { WatchEvent } from './poll.ts';
import { routeByRules, type Route, type WatchRules } from './triage.ts';

// what a subscription covers on its repository: all of it, one pull request across its heads, the runs of one
// branch, one run by id, or the runs of tags matching a glob
export type Scope = { kind: 'repo' } | { kind: 'pr'; number: number } | { kind: 'branch'; name: string } | { kind: 'run'; id: string } | { kind: 'tag'; glob: string };

// settled: the verdict on each pr head, and each completed run off a pr head outside the repo scope. failures: the
// verdicts and failed runs, successes held. all: every completed run as well. none: no ci
export type CiFilter = 'settled' | 'failures' | 'all' | 'none';

export type Filter = { items: boolean; ci: CiFilter; stall: boolean };

// settled, merged, closed, or an iso time: the subscription is removed on its own once reached
export type Until = string;

export type Subscription = {
  id: string;
  repo: string;
  scope: Scope;
  filter: Filter;
  // the agent it belongs to, by the name SendMessage reaches it by; absent for the main loop
  for?: string;
  until?: Until;
};

export const CI_FILTERS: readonly CiFilter[] = ['settled', 'failures', 'all', 'none'];

export function parseScope(text: string | undefined): Scope | string {
  const t = (text ?? 'repo').trim();
  if (t === '' || t === 'repo') return { kind: 'repo' };
  const m = /^(pr|branch|run|tag)\s+(\S+)$/.exec(t);
  if (!m) return `scope must be repo, pr <n>, branch <name>, run <id> or tag <glob>, got "${t}"`;
  const [, kind, arg] = m as unknown as [string, string, string];
  if (kind === 'pr') {
    const n = /^#?(\d+)$/.exec(arg);
    return n ? { kind: 'pr', number: Number(n[1]) } : `pr scope takes a pull request number, got "${arg}"`;
  }
  if (kind === 'run') return /^\d+$/.test(arg) ? { kind: 'run', id: arg } : `run scope takes a run id, got "${arg}"`;
  if (kind === 'branch') return { kind: 'branch', name: arg };
  return { kind: 'tag', glob: arg };
}

export function formatScope(s: Scope): string {
  if (s.kind === 'repo') return 'repo';
  if (s.kind === 'pr') return `pr ${s.number}`;
  if (s.kind === 'branch') return `branch ${s.name}`;
  if (s.kind === 'run') return `run ${s.id}`;
  return `tag ${s.glob}`;
}

export function parseUntil(text: string | undefined, scope: Scope): Until | undefined | { error: string } {
  const t = text?.trim();
  if (!t) return undefined;
  if (t === 'settled') return t;
  if (t === 'merged' || t === 'closed') return scope.kind === 'pr' ? t : { error: `until ${t} needs a pr scope` };
  const at = Date.parse(t);
  return Number.isNaN(at) ? { error: `until must be settled, merged, closed or an iso time, got "${t}"` } : new Date(at).toISOString();
}

export function formatFilter(f: Filter): string {
  return [f.items ? 'items' : 'no items', `ci ${f.ci}`, f.stall ? 'stall' : 'no stall'].join(', ');
}

export function formatSubscription(s: Subscription): string {
  return `${s.id} ${s.repo} ${formatScope(s.scope)} · ${formatFilter(s.filter)}${s.for ? ` · for ${s.for}` : ''}${s.until ? ` · until ${s.until}` : ''}`;
}

// a glob over a tag name: * any run of characters, ? one
export function globMatch(glob: string, name: string): boolean {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`).test(name);
}

const tagOf = (e: WatchEvent): string | undefined => (e.subject?.startsWith('tag:') ? e.subject.slice(4) : undefined);

export function inScope(e: WatchEvent, scope: Scope): boolean {
  switch (scope.kind) {
    case 'repo':
      return true;
    case 'pr':
      return e.kind === 'ci' ? e.subject === `pr:${scope.number}` : e.kind === 'pr' && e.number === scope.number;
    case 'branch':
      return e.kind === 'ci' && e.branch === scope.name && tagOf(e) === undefined;
    case 'run':
      return e.kind === 'ci' && e.run === scope.id;
    case 'tag': {
      const tag = tagOf(e);
      return e.kind === 'ci' && tag !== undefined && globMatch(scope.glob, tag);
    }
  }
}

// what one subscription makes of a ci event in its scope
export function routeCi(e: WatchEvent, sub: Pick<Subscription, 'scope' | 'filter'>, rules: WatchRules): Route {
  const { ci, stall } = sub.filter;
  if (ci === 'none') return { action: 'drop', reason: 'ci off' };
  if (e.settled) return { action: 'deliver', reason: 'ci settled on pr' };
  if (e.stalled) return stall ? { action: 'deliver', reason: 'ci stalled on pr' } : { action: 'drop', reason: 'stall off' };
  if (sub.scope.kind === 'run') return { action: 'deliver', reason: 'ci run completed' };
  if (ci === 'all') return { action: 'deliver', reason: 'ci all' };
  const pr = e.subject?.startsWith('pr:') ? e.subject.slice(3) : undefined;
  if (e.head === 'settled') return { action: 'drop', reason: `ci on pr #${pr}, answered by its settled verdict` };
  if (e.head === 'pending') return { action: 'defer', reason: `ci ${e.conclusion ?? 'unknown'} on pr #${pr}, awaiting the other checks` };
  if (ci === 'settled') return sub.scope.kind === 'repo' ? { action: 'drop', reason: 'ci run off a pr' } : { action: 'deliver', reason: 'ci run completed' };
  if (e.ok === true) return { action: 'defer', reason: 'ci success' };
  if (sub.scope.kind !== 'repo') return { action: 'deliver', reason: `ci failure on ${formatScope(sub.scope)}` };
  const branch = e.branch ?? '';
  const watched = rules.protectedBranches.includes(branch) || (rules.branchPattern ? new RegExp(rules.branchPattern).test(branch) : false);
  return watched ? { action: 'deliver', reason: 'ci failure on watched branch' } : { action: 'defer', reason: 'ci failure elsewhere' };
}

export type Routed = Route & { subs: string[] };

// scope first, then filter: an event no subscription covers is dropped, one several cover goes once, naming each
// subscription that takes it. a delivery outranks a hold, a hold outranks a drop
export function route(e: WatchEvent, subs: Subscription[], rules: WatchRules): Routed {
  const scoped = subs.filter((s) => inScope(e, s.scope));
  if (scoped.length === 0) return { action: 'drop', reason: 'no subscription covers it', subs: [] };
  if (e.kind !== 'ci') {
    const wanted = scoped.filter((s) => s.filter.items);
    if (wanted.length === 0) return { action: 'drop', reason: 'items off', subs: [] };
    return { ...routeByRules(e, rules), subs: wanted.map((s) => s.id) };
  }
  const routes = scoped.map((s) => ({ s, r: routeCi(e, s, rules) }));
  for (const action of ['deliver', 'defer'] as const) {
    const hit = routes.filter((x) => x.r.action === action);
    if (hit.length > 0) return { action, reason: hit[0]!.r.reason, subs: hit.map((x) => x.s.id) };
  }
  return { action: 'drop', reason: routes[0]!.r.reason, subs: [] };
}

// the delivery that uses up an until: settled subscription: a pr's verdict, or elsewhere a completed run or verdict
export function settles(e: WatchEvent, scope: Scope): boolean {
  if (e.kind !== 'ci' || e.stalled) return false;
  return scope.kind === 'pr' ? e.settled === true : e.settled === true || e.run !== undefined;
}

// a subscribe or start as the watch tool takes it
export type SubscribeInput = { repo?: string; scope?: string; items?: boolean; ci?: string; stall?: boolean; until?: string; for?: string };

// the subscription a subscribe asks for: the session's repository unless it names one, the default filter under what
// it sets, owned by the agent that asked. a start takes the session's repository alone, scoped to the pull request or
// branch its for names, else the whole repository
export function subscriptionOf(input: SubscribeInput, how: { start: boolean; repo?: string; filter: Filter; owner?: string }): Omit<Subscription, 'id'> | { error: string } {
  const repo = how.start ? how.repo : input.repo?.trim() || how.repo;
  if (!repo) return { error: 'no repository (pass repo, or run in a checkout of one)' };
  const ref = how.start ? input.for?.trim().replace(/^#(?=\d+$)/, '') : undefined;
  const scope = how.start ? (!ref ? { kind: 'repo' as const } : /^\d+$/.test(ref) ? { kind: 'pr' as const, number: Number(ref) } : { kind: 'branch' as const, name: ref }) : parseScope(input.scope);
  if (typeof scope === 'string') return { error: scope };
  if (input.ci !== undefined && !CI_FILTERS.includes(input.ci as CiFilter)) return { error: `ci must be one of ${CI_FILTERS.join(', ')}` };
  const until = parseUntil(input.until, scope);
  if (typeof until === 'object') return until;
  const filter: Filter = { items: input.items ?? how.filter.items, ci: (input.ci as CiFilter | undefined) ?? how.filter.ci, stall: input.stall ?? how.filter.stall };
  return { repo, scope, filter, ...(how.owner ? { for: how.owner } : {}), ...(until ? { until } : {}) };
}
