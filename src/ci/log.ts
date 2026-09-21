import type { Forge, JobLog, LogStep, PullHead } from '../forge/forge.ts';
import { diffFiles, type DiffFile } from '../repo/diff.ts';
import type { Subject } from '../packs/types.ts';
import { truncate } from '../tokens.ts';

// where a log comes from: a job or a run through the forge (a run reads its first failed job), or the text itself
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
export function logSubject(log: JobLog, pull: LogPull | undefined, ref: string, options: Partial<LogOptions> = {}): Subject {
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
    facts: { lines, total_lines: total, step, has_lines: lines.length > 0, has_pull: pull !== undefined },
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

// the subject for a source: the job's log through the forge with the open pull request on its head, or the text alone
export async function ciSubject(forge: Forge, repo: string | undefined, source: LogSource, options: Partial<LogOptions> = {}): Promise<Subject> {
  if ('text' in source) return logSubject(textLog(source.text), undefined, truncate(source.text, 40), options);
  if (!repo) throw new Error(`no repository: pass repo as the ${forge.name} path or run inside a checkout with a ${forge.name} remote`);
  let jobId: string;
  if ('job' in source) {
    jobId = source.job;
  } else {
    const failed = (await forge.jobs(repo, source.run)).filter((j) => j.done && !j.ok);
    if (failed.length === 0) throw new Error(`run ${source.run} has no failed job`);
    jobId = failed[0]!.id;
  }
  const log = await forge.jobLog(repo, jobId);
  const pull = log.sha ? await pullFor(forge, repo, log.sha).catch(() => undefined) : undefined;
  return logSubject(log, pull, `${repo} job ${jobId}`, options);
}
