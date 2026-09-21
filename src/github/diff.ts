export type LineDiff = { added: string[]; removed: string[]; text: string };

// line diff of two texts: the lines only in each, and a +/- rendering of the whole. the common prefix and
// suffix are stripped before the lcs so a changelog that only grows at the top costs nothing to compare
export function lineDiff(before: string, after: string): LineDiff {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = lcsOps(midA, midB);
  const added = ops.filter((o) => o.op === '+').map((o) => o.line);
  const removed = ops.filter((o) => o.op === '-').map((o) => o.line);
  return { added, removed, text: ops.map((o) => `${o.op}${o.line}`).join('\n') };
}

type Op = { op: '+' | '-'; line: string };

// the edits turning a into b, unchanged lines left out
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ op: '-', line: a[i++]! });
    } else {
      ops.push({ op: '+', line: b[j++]! });
    }
  }
  while (i < n) ops.push({ op: '-', line: a[i++]! });
  while (j < m) ops.push({ op: '+', line: b[j++]! });
  return ops;
}

export type FilePatch = { path: string; patch: string };

// a unified diff split per file, each named by its path after the change (the new name of a rename)
export function splitDiff(diff: string): FilePatch[] {
  const out: FilePatch[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (!header) continue;
    out.push({ path: header[2]!, patch: chunk.trimEnd() });
  }
  return out;
}

export type Drift = { path: string; pr: string; base: string };

// the files both diffs touch, each with its patch from either side, in the order the pr diff lists them
export function driftOf(prDiff: string, baseDiff: string): Drift[] {
  const base = new Map(splitDiff(baseDiff).map((f) => [f.path, f.patch]));
  return splitDiff(prDiff).flatMap((f) => (base.has(f.path) ? [{ path: f.path, pr: f.patch, base: base.get(f.path)! }] : []));
}

export type DiffFile = { path: string; additions: number; deletions: number };

// the files a unified diff touches with the lines added and removed in each, in diff order
export function diffFiles(diff: string): DiffFile[] {
  const out: DiffFile[] = [];
  let current: DiffFile | undefined;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2]!, additions: 0, deletions: 0 };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions++;
  }
  return out;
}
