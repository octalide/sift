import type { Forge, Job, JobLog, LogStep, PullHead } from '../forge/forge.ts';
import { diffFiles, type DiffFile } from '../repo/diff.ts';
import type { Subject } from '../packs/types.ts';
import { truncate } from '../tokens.ts';

// where a log comes from: a job or a run through the forge, or the text itself. a run reads its first job that failed on
// its own, and a job that failed only because a job it needs failed is followed to that job
export type LogSource = { job: string } | { run: string } | { text: string };

export type LogOptions = {
  // lines kept from the end of the failing step, or of the whole log when no step is marked failed
  tailLines: number;
  // characters a line is cut to
  lineWidth: number;
};

export const LOG_DEFAULTS: LogOptions = { tailLines: 300, lineWidth: 400 };

// the pull request whose head the job ran on, as much of it as the judge needs beside the log
export type LogPull = { number: number; title: string; branch: string; files: DiffFile[] };

// one line of the trimmed log, numbered within it
export type LogLine = { n: number; text: string };

const TIMESTAMP = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MARKER = /^##\[(group|endgroup|section|debug|command)\]/;

// a line without the runner's timestamp and terminal colours; group and debug marks carry nothing, an error mark stays
export function cleanLine(line: string): string | undefined {
  const text = line.replace(TIMESTAMP, '').replace(ANSI, '').trimEnd();
  if (text.trim() === '' || MARKER.test(text)) return undefined;
  return text;
}

// the last step marked failed, the one the runner stopped on
export function failingStep(steps: LogStep[]): LogStep | undefined {
  return [...steps].reverse().find((s) => !s.ok);
}

// the lines of the failing step, or of the whole log without one, cleaned and bounded from the end
export function trimLog(log: JobLog, options: Partial<LogOptions> = {}): { step?: string; lines: LogLine[]; total: number } {
  const o = { ...LOG_DEFAULTS, ...options };
  const step = failingStep(log.steps);
  const text = step ? step.text : log.steps.map((s) => s.text).join('\n');
  const cleaned = text
    .split('\n')
    .map(cleanLine)
    .filter((l): l is string => l !== undefined)
    .map((l) => truncate(l, o.lineWidth));
  const kept = cleaned.slice(-o.tailLines);
  return { step: step?.name, lines: kept.map((text, i) => ({ n: i + 1, text })), total: cleaned.length };
}

// the log subject: what is known of the job and its pull request is the state every line is read against,
// the lines are the list the ci pack ranks and feeds back as the kept ones
export function logSubject(log: JobLog, pull: LogPull | undefined, ref: string, options: Partial<LogOptions> = {}, followed: string[] = []): Subject {
  const { step, lines, total } = trimLog(log, options);
  return {
    kind: 'log',
    ref,
    state: {
      job: log.job,
      url: log.url || null,
      failed_step: step ?? null,
      pull_request: pull ? { number: pull.number, title: pull.title, branch: pull.branch, files: pull.files } : null,
    },
    facts: { lines, total_lines: total, step, has_lines: lines.length > 0, has_pull: pull !== undefined, followed },
    options: {},
  };
}

// a log as text, whoever wrote it: one step, marked failed so the tail is what the pack reads
export function textLog(text: string, name = 'log'): JobLog {
  return { job: name, run: '', sha: '', url: '', steps: [{ name, ok: false, text }] };
}

// the open pull request whose head the job ran on and the files its diff touches
async function pullFor(forge: Forge, repo: string, sha: string): Promise<LogPull | undefined> {
  const read = await forge.pulls(repo);
  const head: PullHead | undefined = read.changed ? read.value.find((p) => p.sha === sha) : undefined;
  if (!head) return undefined;
  const diff = await forge.diff(repo, head.number).catch(() => '');
  return { number: head.number, title: head.title, branch: head.branch, files: diffFiles(diff) };
}

const failed = (j: Job): boolean => j.done && !j.ok;

const outcome = (j: Job): string => (j.conclusion === 'failure' ? 'failed' : j.conclusion === 'cancelled' ? 'was cancelled' : `ended ${j.conclusion ?? 'unfinished'}`);

// a, b and c
const series = (words: string[]): string => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]!}`);

const names = (jobs: Job[]): string => series(jobs.map((j) => j.name));

// the failed or cancelled jobs a failed job needs: when there are any, the job is downstream and failed because they did.
// decided from needs and the results alone, never judged
export function failedNeeds(job: Job, jobs: Job[]): Job[] {
  const needs = job.needs;
  if (!failed(job) || !needs) return [];
  return jobs.filter((j) => needs.includes(j.id) && failed(j));
}

// the jobs a downstream job's failure comes from, followed through the downstream jobs between to those that failed on their own
export function rootsOf(job: Job, jobs: Job[]): Job[] {
  const roots: Job[] = [];
  const seen = new Set([job.id]);
  const walk = (j: Job): void => {
    for (const up of failedNeeds(j, jobs)) {
      if (seen.has(up.id)) continue;
      seen.add(up.id);
      if (failedNeeds(up, jobs).length === 0) roots.push(up);
      else walk(up);
    }
  };
  walk(job);
  return roots;
}

// the one line a downstream job is named in instead of judged
export function downstreamLine(job: Job, upstream: Job[]): string {
  return `${job.name}: failed because ${series(upstream.map((j) => `${j.name} ${outcome(j)}`))}`;
}

// a failed job's log, and the failed jobs it needs as read from the run it belongs to
export type Failure = { log: JobLog; job?: Job; jobs: Job[]; upstream: Job[] };

export async function readFailure(forge: Forge, repo: string, id: string, jobsOf: (run: string) => Promise<Job[]> = (run) => forge.jobs(repo, run)): Promise<Failure> {
  const log = await forge.jobLog(repo, id);
  const jobs = log.run ? await jobsOf(log.run) : [];
  const job = jobs.find((j) => j.id === id);
  return { log, job, jobs, upstream: job ? failedNeeds(job, jobs) : [] };
}

// the subject for a job's log, with the open pull request on the commit it ran on
export async function jobSubject(forge: Forge, repo: string, id: string, log: JobLog, options: Partial<LogOptions> = {}, followed: string[] = []): Promise<Subject> {
  const pull = log.sha ? await pullFor(forge, repo, log.sha).catch(() => undefined) : undefined;
  return logSubject(log, pull, `${repo} job ${id}`, options, followed);
}

// the other jobs that failed on their own, named so a report on one does not hide them
const others = (roots: Job[]): string[] => roots.slice(1).map((j) => `${j.name}: ${outcome(j)} on its own, not judged here (job:${j.id})`);

// the subject for a source: the job's log through the forge with the open pull request on its head, or the text alone.
// a downstream job is followed to the job that failed on its own, a run is read through its first such job, and every
// downstream job and every other job left unjudged is named in followed
export async function ciSubject(forge: Forge, repo: string | undefined, source: LogSource, options: Partial<LogOptions> = {}): Promise<Subject> {
  if ('text' in source) return logSubject(textLog(source.text), undefined, truncate(source.text, 40), options);
  if (!repo) throw new Error(`no repository: pass repo as the ${forge.name} path or run inside a checkout with a ${forge.name} remote`);
  if ('job' in source) {
    const read = await readFailure(forge, repo, source.job);
    const roots = read.job ? rootsOf(read.job, read.jobs) : [];
    if (roots.length === 0) return jobSubject(forge, repo, source.job, read.log, options);
    const root = roots[0]!;
    const followed = [`${downstreamLine(read.job!, read.upstream)}, followed to ${names(roots)}`, ...others(roots)];
    return jobSubject(forge, repo, root.id, await forge.jobLog(repo, root.id), options, followed);
  }
  const jobs = await forge.jobs(repo, source.run);
  const bad = jobs.filter(failed);
  if (bad.length === 0) throw new Error(`run ${source.run} has no failed job`);
  const roots = bad.filter((j) => failedNeeds(j, jobs).length === 0);
  if (roots.length === 0) throw new Error(`run ${source.run}: every failed job waits on another failed job`);
  const root = roots[0]!;
  const followed = [...bad.filter((j) => failedNeeds(j, jobs).length > 0).map((j) => downstreamLine(j, failedNeeds(j, jobs))), ...others(roots)];
  return jobSubject(forge, repo, root.id, await forge.jobLog(repo, root.id), options, followed);
}
