import { ruleSource, type GradeHost } from '../grade.ts';
import type { Judge } from '../judge/types.ts';
import { runParts } from '../packs/run.ts';
import type { Pack, Report, Subject } from '../packs/types.ts';
import type { Checkout } from '../repo/checkout.ts';
import type { RepoConfig } from '../repo/config.ts';
import { textRulesSubjects, type TextTarget } from '../repo/subjects.ts';
import type { Rule, RuleSource } from '../rules/discover.ts';
import type { TextKind } from '../rules/kinds.ts';
import { breachText, confirmBreaches } from './breaches.ts';
import { channelTable, defaultChannels, settingsOf, textOf, type Channel } from './channels.ts';
import { verdictKey, type Verdicts } from './verdicts.ts';

// text a tool call is about to send somewhere people read, the hard limit of that channel, what the text is in prose
// and as the kind of text rules govern, and what the write sets beside it (a pull request's base, head and draft);
// denied names the reason the text could not be obtained at all, which the gate refuses without a judge call
export type Outbound = { channel: string; text: string; limit?: number; kind?: string; textKind?: TextKind; sets?: Record<string, string | boolean>; denied?: string };

export type ReadText = (path: string) => Promise<string>;

// the first channel the call is on decides; a body named by file is read here so the gate judges exactly what the command will send
export async function outboundOf(tool: string, input: Record<string, unknown>, read: ReadText, through: Channel[] = defaultChannels()): Promise<Outbound | undefined> {
  for (const c of through) {
    const got = textOf(c, tool, input);
    if (got === undefined) continue;
    const sets = settingsOf(c, input);
    const base = { channel: c.name, limit: c.limit, kind: c.kind, ...(c.textKind ? { textKind: c.textKind } : {}), ...(sets ? { sets } : {}) };
    if ('text' in got) return { ...base, text: got.text };
    if (got.file === '-') return { ...base, text: '', denied: 'the body is read from stdin (--body-file -) with no heredoc in the command, so it cannot be judged; pass --body, a file path or a heredoc' };
    try {
      return { ...base, text: await read(got.file) };
    } catch (err) {
      return { ...base, text: '', denied: `the body file ${got.file} cannot be read (${err instanceof Error ? err.message : String(err)})` };
    }
  }
  return undefined;
}

// report is the text's, one report of every part when it was judged in parts.
// pending: the text is not judged in full yet; it settles to why it could not be, or undefined, and settleDecision then
// judges it again. confirming: what it waits on is the check of the rules the first round found broken, named here,
// rather than the rules themselves being found
export type OutboundDecision = { allow: boolean; reason: string; report?: Report; warnings: string[]; pending?: Promise<string | undefined>; confirming?: string[] };

// the channel's length limit is mechanical; the rules are judged on every part of the text, an unclear rule warns, and
// each is named by the parts it was found in when the text was judged in parts. a rule violated in any part is asked
// again beside the rest of its document and the lines that break it found, off the hook's clock: the decision answers
// pending on that, and the text judged again once it lands meets the verdict it kept. a verdict judged in full is
// kept, and the same text under the same rules meets it again without a judge call
export async function gateOutbound(out: Outbound, subjects: Subject[], pack: Pack, judge: Judge, config: RepoConfig, verdicts: Verdicts): Promise<OutboundDecision> {
  if (out.denied !== undefined) return { allow: false, reason: out.denied, warnings: [] };
  if (out.limit !== undefined && out.text.length > out.limit) {
    return { allow: false, reason: `${out.channel} text is ${out.text.length} chars, the limit is ${out.limit}`, warnings: [] };
  }
  // unjudged text is never let through for want of time: the rules are still being found, and the caller settles the decision once they are
  const pending = subjects.find((s) => s.pending !== undefined);
  if (pending) return { allow: false, reason: pending.pending!, warnings: [], pending: pending.settled ?? Promise.resolve(undefined) };
  const key = verdictKey(out, subjects, pack, judge);
  const kept = await verdicts.get(key);
  if (kept) return kept;
  const flight = verdicts.inFlight(key);
  if (flight && 'settled' in flight) return flight.settled;
  if (flight) return confirming(flight.running, [], []);
  const rules = (subjects[0]?.facts['rules'] as Rule[] | undefined) ?? [];
  const report = await runParts(pack, subjects, judge, config);
  if (report.judgeError) return { allow: true, reason: `judge unavailable (${report.judgeError})`, report, warnings: [] };
  // a rule is asked in the opening and again in each later part, under another question; it is named once, with every part it was found in
  const unclear = new Map<string, string[]>();
  const violated: Rule[] = [];
  for (const item of report.ranked[0]?.items ?? []) {
    const rule = rules[item.index];
    if (rule === undefined) continue;
    for (const j of item.asked) if (j.band === 'unclear' && j.severity !== 'info') unclear.set(rule.text, [...(unclear.get(rule.text) ?? []), ...(j.parts ?? [])]);
    if (item.asked.some((j) => j.band === 'violated' && j.severity !== 'info')) violated.push(rule);
  }
  if (violated.length === 0) {
    const verdict = { allow: true, reason: 'clear', warnings: warningsOf(unclear) };
    await verdicts.set(key, verdict);
    return { ...verdict, report };
  }
  const work = confirmBreaches(report, subjects, judge).then(async (confirmed) => {
    if (!confirmed.ok) return { verdict: { allow: true, reason: `judge unavailable (${confirmed.error})`, warnings: [] }, kept: false };
    // a rule that breaks the text is not also a warning
    for (const u of confirmed.unclear) unclear.set(u.rule.text, [...(unclear.get(u.rule.text) ?? []), ...u.parts]);
    for (const b of confirmed.breaches) unclear.delete(b.rule.text);
    const verdict = confirmed.breaches.length > 0 ? { allow: false, reason: `breaks: ${confirmed.breaches.map(breachText).join(' | ')}`, warnings: warningsOf(unclear) } : { allow: true, reason: 'clear', warnings: warningsOf(unclear) };
    await verdicts.set(key, verdict);
    return { verdict, kept: true };
  });
  return confirming(verdicts.settle(key, work), violated, warningsOf(unclear), report);
}

// a decision pending on the check of the rules the first round found broken, named by their documents
function confirming(running: Promise<unknown>, violated: Rule[], warnings: string[], report?: Report): OutboundDecision {
  const names = violated.map((r) => `${r.source} ${JSON.stringify(r.text)}`);
  return {
    allow: false,
    reason: names.length > 0 ? `may break: ${names.join(' | ')}` : 'the rules this text may break are being checked',
    warnings,
    ...(report ? { report } : {}),
    pending: running.then(
      () => undefined,
      (error: unknown) => `the check of the rules it may break failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
    confirming: names,
  };
}

function warningsOf(unclear: Map<string, string[]>): string[] {
  return [...unclear].map(([rule, at]) => `unclear: ${at.length > 0 ? `${rule} (in ${[...new Set(at)].join(', ')})` : rule}`);
}

// how many times a pending decision waits: the discovery it was pending on, one more when the documents changed while
// it ran and the judgement again found a fresh discovery running, and the check of the rules the text may break
const SETTLE_ROUNDS = 3;

// a pending decision once its rules are known: the text refused unjudged, naming why they could not be found, else
// judged again, which now reads them
export async function settleDecision(decision: OutboundDecision, again: () => Promise<OutboundDecision>): Promise<OutboundDecision> {
  let d = decision;
  for (let round = 0; d.pending; round++) {
    if (round === SETTLE_ROUNDS) return { allow: false, reason: `the text was not judged: ${d.reason}`, warnings: [] };
    const failed = await d.pending;
    if (failed !== undefined) return { allow: false, reason: `the text was not judged: ${failed}`, warnings: [] };
    d = await again();
  }
  return d;
}

// what a pending decision came to once its rules were known: the decision, the action the log records and the text
// the caller is told
// handedOver: another environment makes the post and tells its caller, so this one only logs the text
export type Later = { decision?: OutboundDecision; action: string; text: string; handedOver?: boolean };

// the verdict on text judged before its rules were known, once they are, told under head: the advice on text sent
// under advise, or under enforce the verdict a call refused while they were found would meet
export function verdictLater(mode: Exclude<OutboundMode, 'off'>, out: Outbound, decision: OutboundDecision, again: () => Promise<OutboundDecision>, head: string): Promise<Later> {
  return settleDecision(decision, again).then(
    (d): Later => ({ decision: d, action: enact(mode, d, false).action, text: `${head}: ${verdictOf(out, d)}` }),
    (error: unknown): Later => ({ action: 'fail', text: `${head}: the text was not judged: ${error instanceof Error ? error.message : String(error)}` }),
  );
}

// how outbound text is held to the rules: off judges nothing, advise judges and lets everything through with the
// verdict attached, enforce refuses a broken rule
export const OUTBOUND_MODES = ['off', 'advise', 'enforce'] as const;
export type OutboundMode = (typeof OUTBOUND_MODES)[number];

// what a mode makes of a decision: the action the decision log records, and whether the call is refused. an override
// lets an enforced refusal through; shadow refuses nothing and attaches nothing. a pending decision is recorded
// pending, and again as its verdict once its rules are known
export function enact(mode: OutboundMode, decision: OutboundDecision, shadow: boolean, override?: string): { action: string; refuse: boolean; advise: boolean } {
  if (mode === 'advise') return { action: decision.allow ? 'allow' : shadow ? 'would-advise' : decision.pending ? 'pending' : 'advise', refuse: false, advise: !shadow };
  if (decision.allow) return { action: 'allow', refuse: false, advise: false };
  if (override !== undefined) return { action: 'override', refuse: false, advise: false };
  if (shadow) return { action: 'would-deny', refuse: false, advise: false };
  return { action: decision.pending ? 'pending' : 'deny', refuse: true, advise: false };
}

// the verdict an advised call carries back to its caller
export function verdictOf(out: Outbound, decision: OutboundDecision): string {
  const head = decision.allow ? `sift outbound (${out.channel}): ${decision.reason}` : `sift outbound (${out.channel}), note: ${decision.reason.replace(/^breaks: /, 'this may break ')}`;
  return [head, ...decision.warnings].join('; ');
}

export type GateHost = Pick<GradeHost, 'forge' | 'fs' | 'judge' | 'discoveries'> & { verdicts: Verdicts };

// checkout: the one whose rules judged the text
export type Gated = { outbound: Outbound; decision: OutboundDecision; checkout: Checkout };

// one tool call under the checkout it is made from: that checkout's channel table, rules pack and rule documents;
// undefined when the call sends no text or the checkout has no rules pack
export async function gateCall(host: GateHost, checkout: Checkout, tool: string, input: Record<string, unknown>, read: ReadText): Promise<Gated | undefined> {
  const outbound = await outboundOf(tool, input, read, channelTable(defaultChannels(host.forge), checkout.config.outbound.channels));
  return outbound ? gateText(host, checkout, outbound) : undefined;
}

// text on its way out under the checkout's rules pack and rule documents; undefined when the checkout has no rules pack
export async function gateText(host: GateHost, checkout: Checkout, outbound: Outbound): Promise<Gated | undefined> {
  const pack = checkout.packs['rules'];
  if (!pack) return undefined;
  const subjects = await textRulesSubjects({ forge: host.forge, repo: checkout.repo, source: rulesOf(host, checkout), discoveries: host.discoveries }, outboundTarget(outbound), checkout.config);
  return { outbound, decision: await gateOutbound(outbound, subjects, pack, host.judge, checkout.config, host.verdicts), checkout };
}

// what the rules read of outbound text: the text, what it is and what the write sets beside it
export function outboundTarget(out: Outbound): TextTarget {
  return { text: out.text, ...(out.kind ? { about: out.kind } : {}), ...(out.textKind ? { kind: out.textKind } : {}), ...(out.sets ? { sets: out.sets } : {}) };
}

// a directory in no repository has no rule documents of its own; entries the config names in another repository still read from the forge
function rulesOf(host: GateHost, checkout: Checkout): RuleSource {
  if (checkout.git || checkout.repo) return ruleSource(host, { checkout, named: false }, checkout.repo);
  return { scope: checkout.root, list: async () => [], read: async () => undefined, template: () => false, remote: (repo, path, ref) => host.forge.file(repo, path, ref) };
}
