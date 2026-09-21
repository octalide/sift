import type { Judge } from '../judge/types.ts';
import { runPack } from '../packs/run.ts';
import type { Pack, Subject } from '../packs/types.ts';
import type { RepoConfig } from '../github/config.ts';
import { truncate } from '../tokens.ts';
import type { WatchEvent } from './poll.ts';

export type WatchRules = {
  ignoreSelf: boolean;
  ignoreBots: boolean;
  ci: 'failures' | 'all' | 'none';
  triage: boolean;
  login?: string;
  protectedBranches: string[];
  branchPattern?: string;
};

export type Route = { action: 'deliver' | 'defer' | 'drop' | 'judge'; reason: string };

// rules first: what needs no judgement is settled here
export function routeByRules(e: WatchEvent, rules: WatchRules): Route {
  if (e.kind === 'ci') {
    if (rules.ci === 'none') return { action: 'drop', reason: 'ci off' };
    if (e.settled) return { action: 'deliver', reason: 'ci settled on pr' };
    if (e.stalled) return { action: 'deliver', reason: 'ci stalled on pr' };
    const ok = e.ok === true;
    if (rules.ci === 'all') return { action: 'deliver', reason: 'ci all' };
    if (ok) return { action: 'defer', reason: 'ci success' };
    const branch = e.branch ?? '';
    const watched = rules.protectedBranches.includes(branch) || (rules.branchPattern ? new RegExp(rules.branchPattern).test(branch) : false);
    return watched ? { action: 'deliver', reason: 'ci failure on watched branch' } : { action: 'defer', reason: 'ci failure elsewhere' };
  }
  if (rules.ignoreBots && e.bot) return { action: 'drop', reason: 'bot' };
  if (rules.ignoreSelf && rules.login && e.user === rules.login) return { action: 'defer', reason: 'own write' };
  const changes = e.changes.join(' ');
  if (e.isNew) return e.kind === 'pr' ? { action: 'deliver', reason: 'new pr' } : { action: 'judge', reason: 'new issue' };
  if (/\bmerged\b/.test(changes)) return { action: 'deliver', reason: 'merged' };
  if (/state \w+->closed/.test(changes)) return { action: 'defer', reason: 'closed' };
  if (/state closed->open/.test(changes)) return { action: 'deliver', reason: 'reopened' };
  if (/comments|body edited|title edited|activity/.test(changes)) return { action: 'judge', reason: 'content changed' };
  return { action: 'defer', reason: 'housekeeping' };
}

export type EventDetail = {
  body?: string;
  labels?: string[];
  latestComment?: { by: string; text: string };
  latestReview?: { by: string; state: string; text: string };
  latestReviewComment?: { by: string; path: string; text: string };
};

export function eventSubject(repo: string, e: WatchEvent, detail: EventDetail): Subject {
  return {
    kind: 'event',
    ref: e.id,
    state: {
      repo,
      kind: e.kind,
      number: e.number ?? null,
      title: e.title,
      changes: e.changes,
      author: e.user,
      is_new: e.isNew,
      body: truncate(detail.body ?? '', 8000),
      labels: detail.labels ?? [],
      latest_comment: detail.latestComment ? { by: detail.latestComment.by, text: truncate(detail.latestComment.text, 4000) } : null,
      latest_review: detail.latestReview ? { ...detail.latestReview, text: truncate(detail.latestReview.text, 4000) } : null,
      latest_review_comment: detail.latestReviewComment ? { ...detail.latestReviewComment, text: truncate(detail.latestReviewComment.text, 4000) } : null,
    },
    facts: {},
    options: {},
  };
}

export type Triage = { action: 'deliver' | 'defer'; label: string; actionable?: number; kind?: string; urgency?: string; error?: string };

export async function judgeEvent(pack: Pack, subject: Subject, judge: Judge, config: RepoConfig): Promise<Triage> {
  const report = await runPack(pack, subject, judge, config);
  if (report.judgeError) return { action: 'deliver', label: 'judge unavailable', error: report.judgeError };
  const actionable = report.judged.find((j) => j.id === 'actionable');
  const kind = report.judged.find((j) => j.id === 'kind');
  const urgency = report.judged.find((j) => j.id === 'urgency');
  const p = actionable?.answer?.type === 'noul' ? actionable.answer.p : undefined;
  const kindLabel = kind?.answer?.type === 'choice' ? kind.answer.choice : undefined;
  const urgencyLabel = urgency?.answer?.type === 'score' ? urgency.answer.legend.split(':')[0] : undefined;
  const parts = [p !== undefined ? `actionable ${p.toFixed(2)}` : '', kindLabel ? `kind ${kindLabel}` : '', urgencyLabel ? `urgency ${urgencyLabel}` : ''].filter(Boolean);
  // unclear delivers: the cost of a wasted look is lower than a missed question
  const action = actionable && actionable.band === 'violated' ? 'defer' : 'deliver';
  return { action, label: parts.join(', '), actionable: p, kind: kindLabel, urgency: urgencyLabel };
}
