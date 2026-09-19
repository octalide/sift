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

export type Run = {
  name: string;
  branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  sha: string;
  url: string;
  actor: string;
  updated: string;
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
  // ci only
  conclusion?: string | null;
  branch?: string;
  // set when the event is new
  isNew: boolean;
};

// bump when the stored shape changes; a store from an older version is reseeded
export const STATE_VERSION = 2;

export type WatchState = {
  version: number;
  seeded: boolean;
  seededAt?: string;
  cursor: string;
  items: Record<string, Item>;
  runs: Record<string, Run>;
  etags: { issues?: string; runs?: string };
  deferred: Deferred[];
  paused: boolean;
  login?: string;
  interval: number;
  lastPoll?: number;
  lastDelivery?: number;
  failures: number;
};

export type Deferred = {
  event: WatchEvent;
  reason: string;
  label?: string;
};

export function initialState(): WatchState {
  return {
    version: STATE_VERSION,
    seeded: false,
    cursor: '2008-01-01T00:00:00Z',
    items: {},
    runs: {},
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

// the slim record ITEM_JQ produces server side, so a page of 100 stays small
export const ITEM_JQ = '[.[] | {n: .number, t: .title, s: .state, u: .user.login, ut: .user.type, bl: ((.body // "") | length), bp: ((.body // "")[0:400]), c: .comments, l: ([.labels[].name] | sort | join(",")), up: .updated_at, cr: .created_at, url: .html_url, pr: (.pull_request != null), m: (.pull_request.merged_at != null)}]';

export type RawItem = {
  n: number;
  t: string;
  s: string;
  u: string;
  ut?: string;
  bl: number;
  bp: string;
  c: number;
  l: string;
  up: string;
  cr: string;
  url: string;
  pr: boolean;
  m: boolean;
};

export function toItem(raw: RawItem): Item {
  return {
    kind: raw.pr ? 'pr' : 'issue',
    title: raw.t,
    state: raw.s,
    user: raw.u,
    bot: raw.ut === 'Bot' || raw.u.endsWith('[bot]'),
    bodySig: `${raw.bl}:${hashOf(raw.bp)}`,
    created: raw.cr,
    comments: raw.c,
    labels: raw.l,
    updated: raw.up,
    merged: raw.m,
    url: raw.url,
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

type RawRun = {
  id: number;
  name: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  html_url: string;
  actor?: { login: string };
  updated_at: string;
};

export function toRuns(raw: RawRun[]): Record<string, Run> {
  return Object.fromEntries(
    raw.map((r) => [
      String(r.id),
      {
        name: r.name,
        branch: r.head_branch,
        event: r.event,
        status: r.status,
        conclusion: r.conclusion,
        sha: r.head_sha.slice(0, 7),
        url: r.html_url,
        actor: r.actor?.login ?? '',
        updated: r.updated_at,
      },
    ]),
  );
}

export function diffRuns(old: Record<string, Run>, fresh: Record<string, Run>, now: number): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const [id, v] of Object.entries(fresh)) {
    const o = old[id];
    if (v.status !== 'completed' || (o && o.status === 'completed')) continue;
    events.push({
      id: `ci#${id}`,
      kind: 'ci',
      title: `${v.name} on ${v.branch} @${v.sha} (${v.event})`,
      user: v.actor,
      bot: false,
      url: v.url,
      changes: [`ci ${v.conclusion ?? 'unknown'}`],
      at: now,
      conclusion: v.conclusion,
      branch: v.branch,
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

export function formatEvent(e: WatchEvent): string {
  const head = e.kind === 'ci' ? `ci ${e.conclusion ?? 'unknown'}: ${e.title}` : `${e.kind} #${e.number} ${e.changes.join(', ')}: ${e.title}`;
  return head;
}
