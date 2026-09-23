import { prefixWithin } from '../judge/room.ts';

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

// what a part's size is measured in: characters unless said
export type Size = (text: string) => number;
const chars: Size = (text) => text.length;

// a piece over the cap split at paragraph boundaries, a paragraph over it at line boundaries, a line over it at the cap
function splitPiece(piece: Piece, cap: number, size: Size): Piece[] {
  if (size(piece.text) <= cap) return [piece];
  const paragraphs = piece.text.split(/(?<=\n[ \t]*\n)/);
  const lines = paragraphs.flatMap((p) => (size(p) <= cap ? [p] : linesOf(p)));
  const pieces = lines.flatMap((l) => {
    const out: string[] = [];
    for (let rest = l; rest.length > 0; ) {
      // a cap too small for one character still takes one, so the split always moves on
      const head = prefixWithin(rest, cap, size) || rest.slice(0, 1);
      out.push(head);
      rest = rest.slice(head.length);
    }
    return out;
  });
  return pieces.map((text) => ({ text, heading: piece.heading }));
}

// the text in parts of at most cap in size that concatenate back to it exactly: split at headings, then at
// paragraphs, then at lines, adjacent pieces packed together while they fit. each part names the headings it covers,
// a part that continues a block under the heading of that block
export function partsOf(text: string, cap: number, size: Size = chars): Part[] {
  if (size(text) <= cap) return [{ text, headings: blocksOf(text).flatMap((b) => (b.heading ? [b.heading] : [])) }];
  const parts: Part[] = [];
  let current: Part | undefined;
  for (const piece of blocksOf(text).flatMap((b) => splitPiece(b, cap, size))) {
    if (!current || size(current.text + piece.text) > cap) {
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
