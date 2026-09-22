import type { Job } from './forge.ts';

// one job of a github actions workflow as far as dependencies go: its key, its name template when set, the keys it needs
export type WorkflowJob = { key: string; name?: string; needs: string[] };

const indentOf = (line: string): number => line.length - line.trimStart().length;
const blank = (line: string): boolean => line.trim() === '' || line.trimStart().startsWith('#');

// a plain or quoted scalar without its trailing comment
function scalar(text: string): string {
  const t = text.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const end = t.indexOf(t[0]!, 1);
    return end > 0 ? t.slice(1, end) : t.slice(1);
  }
  return t.replace(/\s+#.*$/, '').trim();
}

// a flow list [a, b], or a single scalar
function list(text: string): string[] {
  const t = text.replace(/\s+#.*$/, '').trim();
  if (!t.startsWith('[')) return t === '' ? [] : [scalar(t)];
  return t.slice(1, t.endsWith(']') ? -1 : undefined).split(',').map(scalar).filter((s) => s !== '');
}

// the jobs block of a workflow file: each job's key, name and needs, read from the yaml's indentation. only the
// shapes a workflow writes these in are read (plain, quoted, flow and block lists); undefined when there is no jobs block
export function workflowJobs(text: string): WorkflowJob[] | undefined {
  const lines = text.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => /^jobs\s*:\s*(#.*)?$/.test(l));
  if (start < 0) return undefined;
  const jobs: WorkflowJob[] = [];
  let keyIndent = -1;
  let propIndent = -1;
  let job: WorkflowJob | undefined;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (blank(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    if (keyIndent < 0) keyIndent = indent;
    if (indent < keyIndent) break;
    if (indent === keyIndent) {
      const m = /^\s*("[^"]+"|'[^']+'|[^\s:#][^:#]*?)\s*:\s*(#.*)?$/.exec(line);
      job = m ? { key: scalar(m[1]!), needs: [] } : undefined;
      if (job) jobs.push(job);
      propIndent = -1;
      continue;
    }
    if (!job) continue;
    if (propIndent < 0) propIndent = indent;
    if (indent !== propIndent) continue;
    const prop = /^\s*(name|needs)\s*:(.*)$/.exec(line);
    if (!prop) continue;
    const value = prop[2]!.trim();
    if (prop[1] === 'name') {
      job.name = scalar(value);
      continue;
    }
    if (value !== '' && !value.startsWith('#')) {
      // a flow list may run over several lines until its bracket closes
      let flow = value;
      while (flow.startsWith('[') && !flow.replace(/\s+#.*$/, '').endsWith(']') && i + 1 < lines.length) flow += ` ${lines[++i]!.trim()}`;
      job.needs = list(flow);
      continue;
    }
    // a block list: the dashed lines under the key
    const items: string[] = [];
    while (i + 1 < lines.length && (blank(lines[i + 1]!) || (indentOf(lines[i + 1]!) >= propIndent && lines[i + 1]!.trimStart().startsWith('-')))) {
      i += 1;
      if (!blank(lines[i]!)) items.push(scalar(lines[i]!.trimStart().slice(1)));
    }
    job.needs = items.filter((s) => s !== '');
  }
  return jobs;
}

const EXPR = /\$\{\{[\s\S]*?\}\}/g;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// how a workflow job's runs are named in the jobs list. without a name the key is the name, and a matrix run of it
// is "key (values)". a name with expressions is matched on its literal parts, and a skipped run keeps the name
// unrendered. a name that is all expression has nothing to match on
function matcher(w: WorkflowJob): { exact: string; pattern?: RegExp; literal: number } | undefined {
  if (w.name === undefined) return { exact: w.key, pattern: new RegExp(`^${escape(w.key)} \\(.*\\)$`), literal: w.key.length };
  const parts = w.name.split(EXPR);
  if (parts.length === 1) return { exact: w.name, literal: w.name.length };
  const literal = parts.join('').trim().length;
  if (literal === 0) return undefined;
  return { exact: w.name, pattern: new RegExp(`^${parts.map(escape).join('.*')}$`), literal };
}

// the jobs of a run with needs filled from the workflow that ran them: each run is mapped to its workflow key, by its
// exact name first and then by the name pattern with the most literal text. a run mapped to no key, or to one that
// needs a key no run maps to, keeps needs undefined and reads as a leaf
export function fillNeeds(jobs: Job[], workflow: WorkflowJob[]): Job[] {
  const matchers = workflow.map((w) => ({ w, m: matcher(w) })).filter((x): x is { w: WorkflowJob; m: NonNullable<ReturnType<typeof matcher>> } => x.m !== undefined);
  const keyOf = (job: Job): string | undefined => {
    const exact = matchers.filter((x) => x.m.exact === job.name);
    if (exact.length > 0) return exact.length === 1 ? exact[0]!.w.key : undefined;
    const hits = matchers.filter((x) => x.m.pattern?.test(job.name)).sort((a, b) => b.m.literal - a.m.literal);
    if (hits.length === 0 || (hits.length > 1 && hits[0]!.m.literal === hits[1]!.m.literal)) return undefined;
    return hits[0]!.w.key;
  };
  const keys = new Map(jobs.map((j) => [j.id, keyOf(j)]));
  const byKey = new Map<string, string[]>();
  for (const [id, key] of keys) if (key !== undefined) byKey.set(key, [...(byKey.get(key) ?? []), id]);
  const needsOf = new Map(workflow.map((w) => [w.key, w.needs]));
  return jobs.map((j) => {
    const key = keys.get(j.id);
    if (key === undefined) return j;
    const needed = needsOf.get(key)!.map((k) => byKey.get(k));
    if (needed.some((ids) => ids === undefined)) return j;
    return { ...j, needs: needed.flat() as string[] };
  });
}
