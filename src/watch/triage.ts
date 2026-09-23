import type { Judge } from '../judge/types.ts';
import { runPack } from '../packs/run.ts';
import type { Pack, Subject } from '../packs/types.ts';
import type { RepoConfig } from '../repo/config.ts';
import { fitTexts } from '../judge/room.ts';
import type { WatchEvent } from './poll.ts';

export type WatchRules = {
  ignoreSelf: boolean;
  ignoreBots: boolean;
  triage: boolean;
  login?: string;
  protectedBranches: string[];
  branchPattern?: string;
};

export type Route = { action: 'deliver' | 'defer' | 'drop' | 'judge'; reason: string };

// rules first: what needs no judgement is settled here. an issue or pr event only, ci is routed per subscription
export function routeByRules(e: WatchEvent, rules: WatchRules): Route {
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

// an event as the triage pack reads it: its body and the latest comment, review and review comment, the body taking room first
export function eventSubject(repo: string, e: WatchEvent, detail: EventDetail): Subject {
  const { latestComment: comment, latestReview: review, latestReviewComment: reviewComment } = detail;
  const fit = fitTexts(
    [
      { name: 'the body', text: detail.body ?? '' },
      { name: 'the latest comment', text: comment?.text ?? '', tier: 1 },
      { name: 'the latest review', text: review?.text ?? '', tier: 1 },
      { name: 'the latest review comment', text: reviewComment?.text ?? '', tier: 1 },
    ],
    ([body, c, r, rc]) => ({
      repo,
      kind: e.kind,
      number: e.number ?? null,
      title: e.title,
      changes: e.changes,
      author: e.user,
      is_new: e.isNew,
      body: body!,
      labels: detail.labels ?? [],
      latest_comment: comment ? { by: comment.by, text: c! } : null,
      latest_review: review ? { ...review, text: r! } : null,
      latest_review_comment: reviewComment ? { ...reviewComment, text: rc! } : null,
    }),
  );
  return {
    kind: 'event',
    ref: e.id,
    state: fit.state,
    facts: {},
    options: {},
    ...(fit.cuts.length > 0 ? { cuts: fit.cuts } : {}),
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
