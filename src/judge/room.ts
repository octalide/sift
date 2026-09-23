import { estimateTokens, estimateTokensOf, JEV_LIMITS } from '../tokens.ts';

// what a state may cost when a subject is judged at once: the judge's state limit, less room for the longest question beside it
export const STATE_ROOM = JEV_LIMITS.stateTokens - 2_000;
// what a batched rank's context may cost: half the state, the items it is read beside taking the other half
export const CONTEXT_ROOM = Math.floor(STATE_ROOM / 2);

// one text a subject sends the judge: the name a report gives it, and its tier, lower tiers taking room first
export type Text = { name: string; text: string; tier?: number };
// a text the judge did not read whole: how many of its characters it read, none when it was dropped
export type Cut = { name: string; judged: number; length: number };

const MARK = '…';

// what a text costs in the state, as the json string it is sent as
export function textTokens(text: string): number {
  return estimateTokens(JSON.stringify(text));
}

// the longest prefix of text whose size is at most cap, its cost in the state unless said, never splitting a surrogate pair
export function prefixWithin(text: string, cap: number, size: (text: string) => number = textTokens): string {
  if (size(text) <= cap) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(text.slice(0, mid)) <= cap) lo = mid;
    else hi = mid - 1;
  }
  const end = text.charCodeAt(lo - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? lo - 1 : lo);
}

// room shared evenly by the texts of one tier, each costing its text and its frame, what the state holds around it when
// it is read at all: a text under its share is whole, the rest cut to an even share of what is left, or left out when
// its share holds no more than its frame
function share(texts: string[], frames: number[], room: number): string[] {
  const order = texts.map((t, i) => ({ i, cost: textTokens(t) - textTokens('') + frames[i]! })).sort((a, b) => a.cost - b.cost);
  const out = [...texts];
  let left = room;
  for (const [n, { i, cost }] of order.entries()) {
    const even = Math.floor(left / (order.length - n));
    if (cost <= even) {
      left -= cost;
      continue;
    }
    // the mark and the rounding of each cut text cost at most two tokens
    const room = even - frames[i]! - 2;
    const kept = room > 0 ? prefixWithin(texts[i]!, room + textTokens('')) : '';
    out[i] = kept ? `${kept}${MARK}` : '';
    left -= kept ? textTokens(out[i]!) - textTokens('') + frames[i]! : 0;
  }
  return out;
}

// the texts as the state built from them fits the room: whole when it fits; otherwise the lower tiers take room first,
// shared evenly within a tier, and a text over its share is cut to it and marked. every text not read whole is a cut
export function fitTexts<S>(texts: Text[], build: (texts: string[]) => S, room = STATE_ROOM): { state: S; texts: string[]; cuts: Cut[] } {
  const whole = texts.map((t) => t.text);
  const state = build(whole);
  if (estimateTokensOf(state) <= room) return { state, texts: whole, cuts: [] };
  const none = texts.map(() => '');
  const bare = estimateTokensOf(build(none));
  // what a text adds beyond its own characters: a state that leaves out an empty text (a thread comment) still frames a read one
  const frames = texts.map((_, i) => Math.max(0, estimateTokensOf(build(none.map((e, j) => (j === i ? 'x' : e)))) - bare - (textTokens('x') - textTokens(''))));
  let budget = room - bare;
  let fitted = whole;
  // the estimate is summed per piece and rounded once, so a fit may pass the room by a token or two; tighten until it holds
  for (let tries = 0; tries < 8; tries++) {
    fitted = texts.map(() => '');
    let left = Math.max(0, budget);
    for (const tier of [...new Set(texts.map((t) => t.tier ?? 0))].sort((a, b) => a - b)) {
      const at = texts.flatMap((t, i) => ((t.tier ?? 0) === tier ? [i] : []));
      const shared = share(
        at.map((i) => whole[i]!),
        at.map((i) => frames[i]!),
        left,
      );
      for (const [n, i] of at.entries()) {
        fitted[i] = shared[n]!;
        left -= fitted[i] ? textTokens(fitted[i]!) - textTokens('') + frames[i]! : 0;
      }
      left = Math.max(0, left);
    }
    const over = estimateTokensOf(build(fitted)) - room;
    if (over <= 0) break;
    budget -= over;
  }
  const cuts = texts.flatMap((t, i) => {
    if (fitted[i] === t.text) return [];
    const judged = fitted[i]!.endsWith(MARK) ? fitted[i]!.length - MARK.length : fitted[i]!.length;
    return [{ name: t.name, judged, length: t.text.length }];
  });
  return { state: build(fitted), texts: fitted, cuts };
}

// what a report says of the cuts: the texts the judge read part of, or none of, because the rest is more than its state holds
export function cutMessage(cuts: Cut[]): string {
  const named = cuts.map((c) => (c.judged === 0 ? `${c.name} (not read)` : `${c.name} (the first ${c.judged} of ${c.length} characters)`));
  return `the judge read part of this subject, the rest is more than its state holds: ${named.join(', ')}`;
}
