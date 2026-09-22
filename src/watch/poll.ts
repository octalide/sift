import type { Check, PullHead, Run, WatchItem } from '../forge/forge.ts';

export type { Run } from '../forge/forge.ts';

export type Item = {
  kind: 'issue' | 'pr';
  title: string;
  state: string;
  user: string;
  bot: boolean;
  // length plus a prefix hash: an edit that changes neither still moves updated_at and surfaces as activity
  bodySig: string;
  created: string;
  comments: number;
  labels: string;
  updated: string;
  merged: boolean;
  url: string;
};

export type WatchEvent = {
  id: string;
  kind: 'issue' | 'pr' | 'ci';
  number?: number;
  title: string;
  user: string;
  bot: boolean;
  url: string;
  changes: string[];
  at: number;
  // ci only: the forge's word for the outcome and whether it passes
  conclusion?: string | null;
  ok?: boolean;
  branch?: string;
  // ci only: what the event reports on, `pr:<n>` when it ran on a head of that pr, else `branch:<name>`, and the commit
  subject?: string;
  sha?: string;
  // ci run only: the run and its workflow; a newer completed run of the same workflow on the same subject supersedes it
  run?: string;
  workflow?: string;
  // every check on the head of an open pr completed; number is the pr
  settled?: boolean;
  // checks on the head of an open pr did not all finish within the stall interval; number is the pr
  stalled?: boolean;
  // settled only: the checks that failed, with the job id of each whose log the forge keeps
  failed?: FailedCheck[];
  // settled failure only: the ci pack's report on each failed check with a log, attached at delivery
  reports?: string[];
  // mechanical findings of the issue pack on a new issue
  findings?: string[];
  // set when the event is new
  isNew: boolean;
};

// bump when the stored shape changes; a store from an older version is reseeded
export const STATE_VERSION = 8;

export type WatchState = {
  version: number;
  seeded: boolean;
  seededAt?: string;
  cursor: string;
  items: Record<string, Item>;
  runs: Record<string, Run>;
  // pr@sha -> conclusion, one settled delivery per head
  settled: Record<string, string>;
  // pr@sha -> the open pr head whose checks have not all finished, one stalled delivery per head
  pending: Record<string, PendingHead>;
  // pr@sha -> the open pr head with no check or status on it yet, looked up once; neither settled nor pending
  unchecked: Record<string, true>;
  // the open pr heads as of the last 200 on the pulls probe; a 304 leaves it in place
  pulls: PullHead[];
  // sha -> pr number of every open pr head seen, newest last, so a run on a head that has since moved still keys to its pr
  heads: Record<string, number>;
  etags: { issues?: string; runs?: string; pulls?: string };
  deferred: Deferred[];
  paused: boolean;
  login?: string;
  // the name of the subagent whose watch start armed the watch; absent when the main loop did
  armedBy?: string;
  // the agents that armed the watch for a pr, by its number or head branch, so each ci verdict names the agent whose pr it is
  armedFor?: ArmedFor[];
  interval: number;
  lastPoll?: number;
  lastDelivery?: number;
  failures: number;
};

export type ArmedFor = { agent: string; ref: string };

export type Deferred = {
  event: WatchEvent;
  reason: string;
  label?: string;
};

export type PendingHead = {
  number: number;
  title: string;
  branch: string;
  sha: string;
  url: string;
  user: string;
  // when the head was first seen open with unfinished checks
  since: number;
  stalled: boolean;
};

export function initialState(): WatchState {
  return {
    version: STATE_VERSION,
    seeded: false,
    cursor: '2008-01-01T00:00:00Z',
    items: {},
    runs: {},
    settled: {},
    pending: {},
    unchecked: {},
    pulls: [],
    heads: {},
    etags: {},
    deferred: [],
    paused: false,
    interval: 0,
    failures: 0,
  };
}

// a short stable hash so the store holds no bodies
export function hashOf(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function toItem(item: WatchItem): Item {
  return {
    kind: item.kind,
    title: item.title,
    state: item.state,
    user: item.author.login,
    bot: item.author.bot,
    bodySig: `${item.body.length}:${hashOf(item.body.head)}`,
    created: item.createdAt,
    comments: item.comments,
    labels: [...item.labels].sort().join(','),
    updated: item.updatedAt,
    merged: item.merged,
    url: item.url,
  };
}

// seededAt bounds the seed window: an unseen item created before it is old activity, not a new item
export function diffItems(old: Record<string, Item>, fresh: Record<string, Item>, now: number, seededAt?: string): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const [n, v] of Object.entries(fresh)) {
    const o = old[n];
    const base = { number: Number(n), title: v.title, user: v.user, bot: v.bot, url: v.url, at: now, kind: v.kind };
    if (!o) {
      const isNew = !seededAt || v.created >= seededAt;
      events.push({ ...base, id: `${v.kind}#${n}@${v.updated}`, changes: [isNew ? `new [${v.state}]` : `activity (first seen, ${v.comments} comments) [${v.state}]`], isNew });
      continue;
    }
    const changes: string[] = [];
    if (o.state !== v.state) changes.push(`state ${o.state}->${v.state}`);
    if (v.merged && !o.merged) changes.push('merged');
    if (o.title !== v.title) changes.push('title edited');
    if (o.bodySig !== v.bodySig) changes.push('body edited');
    if (o.comments !== v.comments) changes.push(`comments ${o.comments}->${v.comments}`);
    if (o.labels !== v.labels) changes.push(`labels [${v.labels}]`);
    if (changes.length === 0 && o.updated !== v.updated) changes.push('activity (review or other)');
    if (changes.length > 0) events.push({ ...base, id: `${v.kind}#${n}@${v.updated}`, changes, isNew: false });
  }
  return events;
}

export function toRuns(runs: Run[]): Record<string, Run> {
  return Object.fromEntries(runs.map((r) => [r.id, r]));
}

export function diffRuns(old: Record<string, Run>, fresh: Record<string, Run>, now: number): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const [id, v] of Object.entries(fresh)) {
    const o = old[id];
    if (!v.done || o?.done) continue;
    events.push({
      id: `ci#${id}`,
      kind: 'ci',
      title: `${v.name} on ${v.branch} @${v.sha.slice(0, 7)} (${v.event})`,
      user: v.actor,
      bot: false,
      url: v.url,
      changes: [`ci ${v.conclusion ?? 'unknown'}`],
      at: now,
      conclusion: v.conclusion,
      ok: v.ok,
      branch: v.branch,
      sha: v.sha,
      run: id,
      workflow: v.name,
      isNew: true,
    });
  }
  return events;
}

// keep the newest runs so the store stays small
export function trimRuns(runs: Record<string, Run>, keep = 200): Record<string, Run> {
  const ids = Object.keys(runs)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(-keep);
  return Object.fromEntries(ids.map((id) => [String(id), runs[String(id)]!]));
}

// the pr heads just listed, added to the known heads as the newest, the oldest trimmed so the store stays small
export function recordHeads(heads: Record<string, number>, pulls: PullHead[], keep = 500): Record<string, number> {
  const out = { ...heads };
  for (const p of pulls) {
    delete out[p.sha];
    out[p.sha] = p.number;
  }
  const keys = Object.keys(out).slice(-keep);
  return Object.fromEntries(keys.map((k) => [k, out[k]!]));
}

// what a run reports on: the pr whose head it ran on, current or past, else its branch. the forge's run does not say
// whether its ref is a branch or a tag, so a tag push keys as `branch:<tag>`
export function runSubject(run: { sha?: string; branch?: string }, heads: Record<string, number>): string {
  const pr = run.sha === undefined ? undefined : heads[run.sha];
  return pr === undefined ? `branch:${run.branch ?? ''}` : `pr:${pr}`;
}

// the newest completed run of a workflow on a subject, newer than the given run id
export function newerRun(runs: Iterable<Run>, match: (r: Run) => boolean, than: string | undefined): Run | undefined {
  let best: Run | undefined;
  for (const r of runs) {
    if (!r.done || !match(r) || Number(r.id) <= Number(than ?? -1)) continue;
    if (!best || Number(r.id) > Number(best.id)) best = r;
  }
  return best;
}

// keep the newest settled heads so the store stays small
export function trimSettled(settled: Record<string, string>, keep = 200): Record<string, string> {
  const keys = Object.keys(settled).slice(-keep);
  return Object.fromEntries(keys.map((k) => [k, settled[k]!]));
}

export type FailedCheck = Pick<Check, 'name' | 'id'>;

// the verdict on a head once every check has finished, undefined while any is pending
export function settleChecks(checks: Check[]): { conclusion: 'success' | 'failure'; total: number; failed: FailedCheck[] } | undefined {
  if (checks.some((c) => !c.done)) return undefined;
  const bad = checks.filter((c) => !c.ok).map((c) => ({ name: c.name, ...(c.id === undefined ? {} : { id: c.id }) }));
  return { conclusion: bad.length > 0 ? 'failure' : 'success', total: checks.length, failed: bad };
}

// the checks on a head that have not finished, named as the settled verdict names failures
export function pendingChecks(checks: Check[]): { pending: string[]; total: number } {
  return { pending: checks.filter((c) => !c.done).map((c) => c.name), total: checks.length };
}

export function formatEvent(e: WatchEvent): string {
  if (e.kind === 'ci' && e.settled) return `ci settled ${e.conclusion ?? 'unknown'}: pr #${e.number} ${e.title}`;
  if (e.kind === 'ci' && e.stalled) return `ci stalled: pr #${e.number} ${e.title}`;
  const head = e.kind === 'ci' ? `ci ${e.conclusion ?? 'unknown'}: ${e.title}` : `${e.kind} #${e.number} ${e.changes.join(', ')}: ${e.title}`;
  return head;
}

// where a ci event's subject stands at delivery, from what the poll already holds: a pr's state and whether its head
// moved, or the newest completed run of the event's workflow on its branch subject, the extra runs counted beside the stored ones
export function currentState(e: WatchEvent, state: Pick<WatchState, 'pulls' | 'items' | 'runs' | 'heads'>, extra: Run[] = []): string {
  const pr = /^pr:(\d+)$/.exec(e.subject ?? '');
  if (pr) {
    const open = state.pulls.find((p) => p.number === Number(pr[1]));
    if (open) return open.sha === e.sha ? 'open, head unchanged' : `open, head @${open.sha.slice(0, 7)} (moved)`;
    const item = state.items[pr[1]!];
    return item?.merged ? 'merged' : item ? 'closed' : 'not open';
  }
  const latest = newerRun([...Object.values(state.runs), ...extra], (r) => r.name === e.workflow && runSubject(r, state.heads) === e.subject, e.run);
  const [sha, conclusion] = latest ? [latest.sha, latest.conclusion] : [e.sha ?? '', e.conclusion];
  return `${e.branch} @${sha.slice(0, 7)}, ${e.workflow} ${conclusion ?? 'unknown'}`;
}

// the agent a ci verdict is for: the one armed for the pr's number or head branch. once any agent is armed for a pr,
// a verdict matching none is for nobody; only a watch armed without refs falls back to whoever armed it last
export function armedAgent(e: WatchEvent, state: Pick<WatchState, 'armedBy' | 'armedFor'>): string | undefined {
  if (e.kind !== 'ci' || !(e.settled || e.stalled)) return undefined;
  if (!state.armedFor?.length) return state.armedBy;
  return state.armedFor.find((a) => a.ref === String(e.number) || a.ref === e.branch)?.agent;
}

// the agent a delivery's header names: whoever armed the watch last, unless the delivery carries a ci event that
// names no agent while agents are armed for prs, which would otherwise be relayed to an agent it has nothing to do with
export function deliveryAgent(events: WatchEvent[], state: Pick<WatchState, 'armedBy' | 'armedFor'>): string | undefined {
  if (!state.armedFor?.length) return state.armedBy;
  return events.some((e) => e.kind === 'ci' && !armedAgent(e, state)) ? undefined : state.armedBy;
}
