import { ruleSource, type GradeHost } from '../grade.ts';
import type { Judge } from '../judge/types.ts';
import { runPack } from '../packs/run.ts';
import type { Pack, Report, Subject } from '../packs/types.ts';
import type { Checkout } from '../repo/checkout.ts';
import type { RepoConfig } from '../repo/config.ts';
import { rulesSubject } from '../repo/subjects.ts';
import type { RuleSource } from '../rules/discover.ts';
import { channelTable, defaultChannels, textOf, type Channel } from './channels.ts';

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

export type OutboundDecision = { allow: boolean; reason: string; report?: Report; warnings: string[] };

// the channel's length limit is mechanical; the rules are judged, a violated rule denies, an unclear one warns
export async function gateOutbound(out: Outbound, subject: Subject, pack: Pack, judge: Judge, config: RepoConfig): Promise<OutboundDecision> {
  if (out.denied !== undefined) return { allow: false, reason: out.denied, warnings: [] };
  if (out.limit !== undefined && out.text.length > out.limit) {
    return { allow: false, reason: `${out.channel} text is ${out.text.length} chars, the limit is ${out.limit}`, warnings: [] };
  }
  const report = await runPack(pack, subject, judge, config);
  if (report.judgeError) return { allow: true, reason: `judge unavailable (${report.judgeError})`, report, warnings: [] };
  const judged = [...report.judged, ...report.ranked.flatMap((r) => r.items)];
  const rule = (id: string) => judged.find((j) => j.id === id)?.instructions.replace(/^The subject(?: \([^)]*\))? complies with this rule: /, '') ?? id;
  const violated = judged.filter((j) => j.band === 'violated' && j.severity !== 'info');
  const unclear = judged.filter((j) => j.band === 'unclear' && j.severity !== 'info');
  const warnings = unclear.map((j) => `unclear: ${rule(j.id)}`);
  if (violated.length > 0) return { allow: false, reason: `breaks: ${violated.map((j) => rule(j.id)).join(' | ')}`, report, warnings };
  return { allow: true, reason: 'clear', report, warnings };
}

export type GateHost = Pick<GradeHost, 'forge' | 'fs' | 'judge' | 'store' | 'now' | 'notice'>;

export type Gated = { outbound: Outbound; decision: OutboundDecision };

// one tool call under the checkout it is made from: that checkout's channel table, rules pack and rule documents;
// undefined when the call sends no text or the checkout has no rules pack
export async function gateCall(host: GateHost, checkout: Checkout, tool: string, input: Record<string, unknown>, read: ReadText): Promise<Gated | undefined> {
  const outbound = await outboundOf(tool, input, read, channelTable(defaultChannels(host.forge), checkout.config.outbound.channels));
  const pack = checkout.packs['rules'];
  if (!outbound || !pack) return undefined;
  const subject = await rulesSubject({ forge: host.forge, repo: checkout.repo, source: rulesOf(host, checkout), judge: host.judge, store: host.store, now: host.now, notice: host.notice }, { kind: 'text', ref: outbound.text, about: outbound.kind }, checkout.config);
  return { outbound, decision: await gateOutbound(outbound, subject, pack, host.judge, checkout.config) };
}

// a directory in no repository has no rule documents of its own; entries the config names in another repository still read from the forge
function rulesOf(host: GateHost, checkout: Checkout): RuleSource {
  if (checkout.git || checkout.repo) return ruleSource(host, { checkout, named: false }, undefined);
  return { scope: checkout.root, list: async () => [], read: async () => undefined, templates: async () => [], remote: (repo, path, ref) => host.forge.file(repo, path, ref) };
}
