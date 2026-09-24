import { ruleSource, type GradeHost } from '../grade.ts';
import type { Judge } from '../judge/types.ts';
import { runParts } from '../packs/run.ts';
import type { Pack, Report, Subject } from '../packs/types.ts';
import type { Checkout } from '../repo/checkout.ts';
import type { RepoConfig } from '../repo/config.ts';
import { textRulesSubjects } from '../repo/subjects.ts';
import type { RuleSource } from '../rules/discover.ts';
import { channelTable, defaultChannels, textOf, type Channel } from './channels.ts';
import { verdictKey, type Verdicts } from './verdicts.ts';

// text a tool call is about to send somewhere people read, the hard limit of that channel, and what the text is;
// denied names the reason the text could not be obtained at all, which the gate refuses without a judge call
export type Outbound = { channel: string; text: string; limit?: number; kind?: string; denied?: string };

export type ReadText = (path: string) => Promise<string>;

// the first channel the call is on decides; a body named by file is read here so the gate judges exactly what the command will send
export async function outboundOf(tool: string, input: Record<string, unknown>, read: ReadText, through: Channel[] = defaultChannels()): Promise<Outbound | undefined> {
  for (const c of through) {
    const got = textOf(c, tool, input);
    if (got === undefined) continue;
    const base = { channel: c.name, limit: c.limit, kind: c.kind };
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
// pending: the text could not be judged yet and the same call made again can be
export type OutboundDecision = { allow: boolean; reason: string; report?: Report; warnings: string[]; pending?: boolean };

// the channel's length limit is mechanical; the rules are judged on every part of the text, a violated rule in any part
// denies, an unclear one warns, each named by the parts it was found in when the text was judged in parts. a verdict
// judged in full is kept, and the same text under the same rules meets it again without a judge call
export async function gateOutbound(out: Outbound, subjects: Subject[], pack: Pack, judge: Judge, config: RepoConfig, verdicts: Verdicts): Promise<OutboundDecision> {
  if (out.denied !== undefined) return { allow: false, reason: out.denied, warnings: [] };
  if (out.limit !== undefined && out.text.length > out.limit) {
    return { allow: false, reason: `${out.channel} text is ${out.text.length} chars, the limit is ${out.limit}`, warnings: [] };
  }
  // unjudged text is never let through for want of time: the rules are still being found, and the retry finds them
  const pending = subjects.find((s) => s.pending !== undefined);
  if (pending) return { allow: false, reason: pending.pending!, warnings: [], pending: true };
  const key = verdictKey(out, subjects, pack, judge);
  const kept = await verdicts.get(key);
  if (kept) return kept;
  const report = await runParts(pack, subjects, judge, config);
  if (report.judgeError) return { allow: true, reason: `judge unavailable (${report.judgeError})`, report, warnings: [] };
  // a rule is asked in the opening and again in each later part, under another question; it is named once, with every part it was found in
  const found = (band: 'violated' | 'unclear') => {
    const byRule = new Map<string, string[]>();
    for (const j of [...report.judged, ...report.ranked.flatMap((s) => s.items.flatMap((item) => item.asked))]) {
      if (j.band !== band || j.severity === 'info') continue;
      const rule = ruleOf(j.instructions);
      byRule.set(rule, [...(byRule.get(rule) ?? []), ...(j.parts ?? [])]);
    }
    return [...byRule].map(([rule, at]) => (at.length > 0 ? `${rule} (in ${at.join(', ')})` : rule));
  };
  const violated = found('violated');
  const warnings = found('unclear').map((w) => `unclear: ${w}`);
  const verdict = violated.length > 0 ? { allow: false, reason: `breaks: ${violated.join(' | ')}` } : { allow: true, reason: 'clear' };
  await verdicts.set(key, { ...verdict, warnings });
  return { ...verdict, report, warnings };
}

// how outbound text is held to the rules: off judges nothing, advise judges and lets everything through with the
// verdict attached, enforce refuses a broken rule
export const OUTBOUND_MODES = ['off', 'advise', 'enforce'] as const;
export type OutboundMode = (typeof OUTBOUND_MODES)[number];

// what a mode makes of a decision: the action the decision log records, and whether the call is refused. an override
// lets an enforced refusal through; shadow refuses nothing and attaches nothing
export function enact(mode: OutboundMode, decision: OutboundDecision, shadow: boolean, override?: string): { action: string; refuse: boolean; advise: boolean } {
  if (mode === 'advise') return { action: decision.allow ? 'allow' : shadow ? 'would-advise' : 'advise', refuse: false, advise: !shadow };
  if (decision.allow) return { action: 'allow', refuse: false, advise: false };
  if (override !== undefined) return { action: 'override', refuse: false, advise: false };
  return { action: shadow ? 'would-deny' : 'deny', refuse: !shadow, advise: false };
}

// the verdict an advised call carries back to its caller
export function verdictOf(out: Outbound, decision: OutboundDecision): string {
  const head = decision.allow ? `sift outbound (${out.channel}): ${decision.reason}` : `sift outbound (${out.channel}), note: ${decision.reason.replace(/^breaks: /, 'this may break ')}`;
  return [head, ...decision.warnings].join('; ');
}

// the rule a rules question quotes, after the subject it names and what it asks of it
function ruleOf(instructions: string): string {
  return instructions.replace(/^.*? (?:complies with|does not break) this rule: /s, '');
}

export type GateHost = Pick<GradeHost, 'forge' | 'fs' | 'judge' | 'discoveries'> & { verdicts: Verdicts };

export type Gated = { outbound: Outbound; decision: OutboundDecision };

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
  const subjects = await textRulesSubjects({ forge: host.forge, repo: checkout.repo, source: rulesOf(host, checkout), discoveries: host.discoveries }, { text: outbound.text, about: outbound.kind }, checkout.config);
  return { outbound, decision: await gateOutbound(outbound, subjects, pack, host.judge, checkout.config, host.verdicts) };
}

// a directory in no repository has no rule documents of its own; entries the config names in another repository still read from the forge
function rulesOf(host: GateHost, checkout: Checkout): RuleSource {
  if (checkout.git || checkout.repo) return ruleSource(host, { checkout, named: false }, checkout.repo);
  return { scope: checkout.root, list: async () => [], read: async () => undefined, template: () => false, remote: (repo, path, ref) => host.forge.file(repo, path, ref) };
}
