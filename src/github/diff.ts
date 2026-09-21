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
