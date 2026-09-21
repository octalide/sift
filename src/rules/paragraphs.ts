// a markdown table row is one rule, its cells named by the header: "5.x: a; 6.0.0: b"
function tableRows(lines: string[]): string[] {
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  const header = cells(lines[0]!);
  return lines
    .slice(2)
    .map(cells)
    .filter((row) => row.some((c) => c.length > 0))
    .map((row) => row.map((c, i) => (header[i] ? `${header[i]}: ${c}` : c)).join('; '));
}

// paragraphs, list items and table rows of a document, each prefixed by its heading; code blocks are skipped
export function ruleParagraphs(markdown: string): string[] {
  const out: string[] = [];
  let heading = '';
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (text.length < 12 || text.startsWith('```')) return;
    out.push(heading ? `${heading}: ${text}` : text);
  };
  let inCode = false;
  let table: string[] = [];
  const flushTable = () => {
    if (table.length >= 2) for (const row of tableRows(table)) out.push(heading ? `${heading}: ${row}` : row);
    table = [];
  };
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (table.length === 0) flush();
      table.push(line);
      continue;
    }
    flushTable();
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      flush();
      heading = h[1]!.trim();
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flush();
      buffer.push(line.replace(/^\s*([-*+]|\d+\.)\s+/, ''));
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    buffer.push(line.trim());
  }
  flushTable();
  flush();
  return out;
}
