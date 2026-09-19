import type { Gh } from '../github/gh.ts';
import type { RepoConfig } from '../github/config.ts';
import type { Judge } from '../judge/types.ts';
import { runPack } from '../packs/run.ts';
import type { Pack, Subject } from '../packs/types.ts';
import { truncate } from '../tokens.ts';

export type Ref = { repo: string; number: number };

const MAX_REFS = 3;
const DIFF_CAP = 8_000;
const BODY_CAP = 6_000;

// pr and issue references in a message: full urls, owner/name#n, and bare #n against the session's repo
export function messageRefs(text: string, defaultRepo?: string): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<string>();
  const add = (repo: string, n: number) => {
    const key = `${repo}#${n}`;
    if (seen.has(key) || out.length >= MAX_REFS) return;
    seen.add(key);
    out.push({ repo, number: n });
  };
  for (const m of text.matchAll(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/g)) add(m[1]!, Number(m[2]));
  for (const m of text.matchAll(/(?<![\w/])([\w.-]+\/[\w.-]+)#(\d+)/g)) add(m[1]!, Number(m[2]));
  if (defaultRepo) for (const m of text.matchAll(/(?<![\w/])#(\d+)\b/g)) add(defaultRepo, Number(m[1]));
  return out;
}

export type RefDetail = {
  repo: string;
  number: number;
  kind: 'pr' | 'issue';
  title: string;
  state: string;
  merged: boolean;
  body: string;
  checks?: { failed: string[]; pending: string[]; total: number };
  diff?: string;
  error?: string;
};

type GhItem = { title: string; state: string; body: string | null; pull_request?: unknown };
type GhPull = { merged: boolean; head: { sha: string } };
type GhCheck = { name: string; status: string; conclusion: string | null };

// enough of the referenced item to judge whether it carries what the message claims about it
export async function refDetail(gh: Gh, ref: Ref): Promise<RefDetail> {
  const base = `repos/${ref.repo}`;
  try {
    const item = await gh.json<GhItem>(`${base}/issues/${ref.number}`);
    const detail: RefDetail = { ...ref, kind: item.pull_request ? 'pr' : 'issue', title: item.title, state: item.state, merged: false, body: truncate(item.body ?? '', BODY_CAP) };
    if (!item.pull_request) return detail;
    const [pull, diff] = await Promise.all([gh.json<GhPull>(`${base}/pulls/${ref.number}`), gh.text(`${base}/pulls/${ref.number}`, 'application/vnd.github.diff').catch(() => '')]);
    const checks = await gh
      .json<{ check_runs: GhCheck[] }>(`${base}/commits/${pull.head.sha}/check-runs?per_page=100`)
      .then((r) => r.check_runs)
      .catch(() => [] as GhCheck[]);
    detail.merged = pull.merged;
    detail.diff = truncate(diff, DIFF_CAP, '\n[diff truncated]');
    detail.checks = {
      failed: checks.filter((c) => c.status === 'completed' && c.conclusion && !['success', 'skipped', 'neutral'].includes(c.conclusion)).map((c) => c.name),
      pending: checks.filter((c) => c.status !== 'completed').map((c) => c.name),
      total: checks.length,
    };
    return detail;
  } catch (error) {
    return { ...ref, kind: 'issue', title: '', state: 'unknown', merged: false, body: '', error: error instanceof Error ? error.message : String(error) };
  }
}

export function messageSubject(text: string, origin: string, refs: RefDetail[]): Subject {
  return {
    kind: 'message',
    ref: truncate(text.split('\n')[0] ?? '', 60),
    state: {
      origin,
      text: truncate(text, 12_000),
      refs: refs.map((r) => ({ ...r, url: `https://github.com/${r.repo}/${r.kind === 'pr' ? 'pull' : 'issues'}/${r.number}` })),
    },
    facts: { has_refs: refs.some((r) => !r.error) },
    options: {},
  };
}

export type MessageTriage = {
  action: 'deliver' | 'consume';
  // the scores, one line
  label: string;
  error?: string;
};

export async function judgeMessage(pack: Pack, subject: Subject, judge: Judge, config: RepoConfig): Promise<MessageTriage> {
  const report = await runPack(pack, subject, judge, config);
  if (report.judgeError) return { action: 'deliver', label: 'judge unavailable', error: report.judgeError };
  const parts: string[] = [];
  for (const j of report.judged) {
    const a = j.answer;
    parts.push(a.type === 'noul' ? `${j.id} ${a.p.toFixed(2)}` : a.type === 'choice' ? `${j.id} ${a.choice}` : `${j.id} ${a.legend.split(':')[0]}`);
  }
  const actionable = report.judged.find((j) => j.id === 'actionable');
  // unclear delivers: a wasted look costs less than a swallowed ask
  return { action: actionable && actionable.band === 'violated' ? 'consume' : 'deliver', label: parts.join(', ') };
}

export type Held = { at: number; from: string; head: string; label: string };

export function heldDigest(held: Held[]): string {
  if (held.length === 0) return '';
  return `held meanwhile (${held.length}): ${held.map((h) => `${h.from}: ${truncate(h.head, 80)} [${h.label}]`).join(' · ')}`;
}
