export type Item = {
  kind: 'issue' | 'pr';
  title: string;
  state: string;
  user: string;
  bot: boolean;
  bodyHash: string;
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

export type WatchState = {
  seeded: boolean;
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

type RawIssue = {
  number: number;
  title: string;
  state: string;
  user: { login: string; type?: string };
  body: string | null;
  comments: number;
  labels: { name: string }[];
  updated_at: string;
  html_url: string;
  pull_request?: { merged_at?: string | null };
};

export function toItem(raw: RawIssue): Item {
  return {
    kind: raw.pull_request ? 'pr' : 'issue',
    title: raw.title,
    state: raw.state,
    user: raw.user.login,
    bot: raw.user.type === 'Bot' || raw.user.login.endsWith('[bot]'),
    bodyHash: hashOf(raw.body ?? ''),
    comments: raw.comments,
    labels: raw.labels
      .map((l) => l.name)
      .sort()
      .join(','),
    updated: raw.updated_at,
    merged: !!raw.pull_request?.merged_at,
    url: raw.html_url,
  };
}

export function diffItems(old: Record<string, Item>, fresh: Record<string, Item>, now: number): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const [n, v] of Object.entries(fresh)) {
    const o = old[n];
    const base = { number: Number(n), title: v.title, user: v.user, bot: v.bot, url: v.url, at: now, kind: v.kind };
    if (!o) {
      events.push({ ...base, id: `${v.kind}#${n}@${v.updated}`, changes: [`new [${v.state}]`], isNew: true });
      continue;
    }
    const changes: string[] = [];
    if (o.state !== v.state) changes.push(`state ${o.state}->${v.state}`);
    if (v.merged && !o.merged) changes.push('merged');
    if (o.title !== v.title) changes.push('title edited');
    if (o.bodyHash !== v.bodyHash) changes.push('body edited');
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
