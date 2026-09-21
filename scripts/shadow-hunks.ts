// shadow run for the hunks pack (#65): the real judge over merged pull requests of this repository, two ways.
// whole-diff asks the pr pack's workaround and scope_creep of the whole diff; per-hunk asks the hunks pack's
// workaround and unrelated of every hunk alone. prints one markdown table row per pull request.
// not shipped: node scripts/shadow-hunks.ts <repo> <from> <to>
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { GitHubForge } from '../src/forge/github.ts';
import { resolveConfig } from '../src/github/config.ts';
import { prSubject } from '../src/github/subjects.ts';
import { JEV_DEFAULTS, JevJudge } from '../src/judge/jev.ts';
import type { Judge, Judgement, Questions, Usage } from '../src/judge/types.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import { runPack } from '../src/packs/run.ts';
import type { Pack, RankedItem, Report } from '../src/packs/types.ts';
import type { RunLike } from '../src/process.ts';

const [repo = 'octalide/sift', from = '69', to = '103'] = process.argv.slice(2);
const apiKey = process.env['TYPESAFE_API_KEY'];
if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');

const run: RunLike = (argv, init) =>
  new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { cwd: init?.cwd, maxBuffer: 64 * 1024 * 1024, timeout: init?.timeoutMs }, (err, stdout, stderr) => {
      resolve({ exitCode: err && 'code' in err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const forge = new GitHubForge(run);
const config = resolveConfig(JSON.parse(await readFile(new URL('../.sift/config.json', import.meta.url), 'utf8')));
const jev = new JevJudge({ apiKey, model: JEV_DEFAULTS.model, baseUrl: JEV_DEFAULTS.baseUrl }, async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, ok: r.ok, text: await r.text() };
});

// counts every request and its usage so each run reports what it cost
type Cost = { requests: number; usage: Usage };
function counting(inner: Judge, cost: Cost): Judge {
  return {
    name: inner.name,
    ask: async (state: unknown, questions: Questions): Promise<Judgement> => {
      const result = await inner.ask(state, questions);
      cost.requests++;
      if (result.usage) {
        cost.usage.requestTokens += result.usage.requestTokens;
        cost.usage.responseTokens += result.usage.responseTokens;
        if (result.usage.source === 'estimate') cost.usage.source = 'estimate';
      }
      return result;
    },
  };
}

const pr = BUILTIN_PACKS['pr']!;
const hunks = BUILTIN_PACKS['hunks']!;
const wholePack: Pack = { ...pr, name: 'whole', checks: [], rank: [], questions: { workaround: pr.questions['workaround']!, scope_creep: pr.questions['scope_creep']! } };
const step = hunks.rank![0]!;
const hunkPack: Pack = { ...hunks, name: 'hunks', rank: [{ ...step, list: 'each', questions: { unrelated: step.questions['unrelated']!, workaround: step.questions['workaround']! } }] };

const p = (report: Report, id: string): number | undefined => {
  const j = report.judged.find((x) => x.id === id);
  return j?.answer?.type === 'noul' ? j.answer.p : undefined;
};
const perHunk = (items: RankedItem[], qid: string): number[] => items.flatMap((i) => (i.answers[qid]?.type === 'noul' ? [i.answers[qid].p] : []));
const stat = (xs: number[]) => (xs.length === 0 ? { max: NaN, mean: NaN } : { max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length });
const f = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? '-' : n.toFixed(2));
const cost = (c: Cost) => `${c.requests} / ${c.usage.requestTokens + c.usage.responseTokens}${c.usage.source === 'estimate' ? '~' : ''}`;

console.log('| PR | hunks | whole workaround | hunk workaround max / mean | whole scope_creep | hunk unrelated max / mean | whole req / tokens | hunk req / tokens |');
console.log('|---|---|---|---|---|---|---|---|');
const details: string[] = [];
for (let n = Number(from); n <= Number(to); n++) {
  let pull;
  try {
    pull = await forge.pull(repo, n);
  } catch {
    continue;
  }
  if (!pull.merged) continue;
  const subject = await prSubject(forge, repo, n, config);
  const wholeCost: Cost = { requests: 0, usage: { requestTokens: 0, responseTokens: 0, source: 'backend' } };
  const hunkCost: Cost = { requests: 0, usage: { requestTokens: 0, responseTokens: 0, source: 'backend' } };
  const whole = await runPack(wholePack, subject, counting(jev, wholeCost), config);
  const byHunk = await runPack(hunkPack, subject, counting(jev, hunkCost), config);
  if (whole.judgeError || byHunk.judgeError) {
    console.log(`| #${n} | judge error: ${whole.judgeError ?? byHunk.judgeError} |`);
    continue;
  }
  const items = byHunk.ranked[0]?.items ?? [];
  const w = stat(perHunk(items, 'workaround'));
  const u = stat(perHunk(items, 'unrelated'));
  console.log(`| #${n} | ${items.length} | ${f(p(whole, 'workaround'))} | ${f(w.max)} / ${f(w.mean)} | ${f(p(whole, 'scope_creep'))} | ${f(u.max)} / ${f(u.mean)} | ${cost(wholeCost)} | ${cost(hunkCost)} |`);
  // the hunks nearing the violated line, for reading what per-hunk flagged
  for (const i of items) {
    const ww = i.answers['workaround'];
    const uu = i.answers['unrelated'];
    const hi = (a: typeof ww) => a?.type === 'noul' && a.p >= 0.4;
    if (hi(ww) || hi(uu)) details.push(`#${n} ${i.label}: workaround ${f(ww?.type === 'noul' ? ww.p : undefined)}, unrelated ${f(uu?.type === 'noul' ? uu.p : undefined)}`);
  }
}
console.log('');
console.log('hunks at or over 0.40 on either question:');
for (const d of details) console.log(`  ${d}`);
