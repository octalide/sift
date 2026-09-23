// one part of a text too long to judge at once: its exact slice and the headings of the blocks it covers
export type Part = { text: string; headings: string[] };

type Piece = { text: string; heading?: string };

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

// the text as lines, each keeping its newline, so the lines concatenate back to the text
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// markdown heading blocks: a block starts at a heading line outside a code fence and runs to the next one
function blocksOf(text: string): Piece[] {
  const blocks: Piece[] = [];
  let current: Piece = { text: '' };
  let fenced = false;
  for (const line of linesOf(text)) {
    if (FENCE.test(line)) fenced = !fenced;
    const h = fenced ? null : HEADING.exec(line.replace(/\n$/, ''));
    if (h) {
      if (current.text) blocks.push(current);
      current = { text: '', heading: h[1]! };
    }
    current.text += line;
  }
  if (current.text) blocks.push(current);
  return blocks;
}

// a piece over the cap split at paragraph boundaries, a paragraph over it at line boundaries, a line over it at the cap
function splitPiece(piece: Piece, cap: number): Piece[] {
  if (piece.text.length <= cap) return [piece];
  const paragraphs = piece.text.split(/(?<=\n[ \t]*\n)/);
  const lines = paragraphs.flatMap((p) => (p.length <= cap ? [p] : linesOf(p)));
  const pieces = lines.flatMap((l) => {
    const out: string[] = [];
    for (let at = 0; at < l.length; at += cap) out.push(l.slice(at, at + cap));
    return out;
  });
  return pieces.map((text) => ({ text, heading: piece.heading }));
}

// the text in parts of at most cap characters that concatenate back to it exactly: split at headings, then at
// paragraphs, then at lines, adjacent pieces packed together while they fit. each part names the headings it covers,
// a part that continues a block under the heading of that block
export function partsOf(text: string, cap: number): Part[] {
  if (text.length <= cap) return [{ text, headings: blocksOf(text).flatMap((b) => (b.heading ? [b.heading] : [])) }];
  const parts: Part[] = [];
  let current: Part | undefined;
  for (const piece of blocksOf(text).flatMap((b) => splitPiece(b, cap))) {
    if (!current || current.text.length + piece.text.length > cap) {
      current = { text: '', headings: [] };
      parts.push(current);
    }
    current.text += piece.text;
    if (piece.heading && current.headings[current.headings.length - 1] !== piece.heading) current.headings.push(piece.heading);
  }
  return parts;
}

// a part by its place and the headings it covers: part 2 of 3 ("Fixes" to "Docs")
export function partName(part: Part, index: number, of: number): string {
  const h = part.headings;
  const under = h.length === 0 ? '' : h.length === 1 ? ` ("${h[0]}")` : ` ("${h[0]}" to "${h[h.length - 1]}")`;
  return `part ${index + 1} of ${of}${under}`;
}
