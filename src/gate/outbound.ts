import { ruleSource, type GradeHost } from '../grade.ts';
import type { Judge } from '../judge/types.ts';
import { runPack } from '../packs/run.ts';
import type { Pack, Report, Subject } from '../packs/types.ts';
import type { Checkout } from '../repo/checkout.ts';
import type { RepoConfig } from '../repo/config.ts';
import { textRulesSubjects } from '../repo/subjects.ts';
import { pool } from '../pool.ts';
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

// report is the whole text's, or its opening's when it was judged in parts; parts holds the report of every later part
export type OutboundDecision = { allow: boolean; reason: string; report?: Report; parts?: Report[]; warnings: string[] };

// how many parts of a long text are judged at once
const PARTS_IN_FLIGHT = 4;

// the channel's length limit is mechanical; the rules are judged on every part of the text, a violated rule in any part
// denies, an unclear one warns, each named by the parts it was found in when the text was judged in parts
export async function gateOutbound(out: Outbound, subjects: Subject[], pack: Pack, judge: Judge, config: RepoConfig): Promise<OutboundDecision> {
  if (out.denied !== undefined) return { allow: false, reason: out.denied, warnings: [] };
  if (out.limit !== undefined && out.text.length > out.limit) {
    return { allow: false, reason: `${out.channel} text is ${out.text.length} chars, the limit is ${out.limit}`, warnings: [] };
  }
  const reports = await pool(subjects, PARTS_IN_FLIGHT, (s) => runPack(pack, s, judge, config));
  const [report, ...parts] = reports;
  const reported = { report, ...(parts.length > 0 ? { parts } : {}) };
  const failed = reports.find((r) => r.judgeError);
  if (failed) return { allow: true, reason: `judge unavailable (${failed.judgeError})`, ...reported, warnings: [] };
  const found = (band: 'violated' | 'unclear') => {
    const byRule = new Map<string, string[]>();
    reports.forEach((r, i) => {
      const part = subjects[i]!.facts['part'];
      for (const j of [...r.judged, ...r.ranked.flatMap((s) => s.items.flatMap((item) => item.asked))]) {
        if (j.band !== band || j.severity === 'info') continue;
        const rule = ruleOf(j.instructions);
        const at = byRule.get(rule) ?? [];
        if (typeof part === 'string') at.push(part);
        byRule.set(rule, at);
      }
    });
    return [...byRule].map(([rule, at]) => (at.length > 0 ? `${rule} (in ${at.join(', ')})` : rule));
  };
  const violated = found('violated');
  const warnings = found('unclear').map((w) => `unclear: ${w}`);
  if (violated.length > 0) return { allow: false, reason: `breaks: ${violated.join(' | ')}`, ...reported, warnings };
  return { allow: true, reason: 'clear', ...reported, warnings };
}

// the rule a rules question quotes, after the subject it names and what it asks of it
function ruleOf(instructions: string): string {
  return instructions.replace(/^.*? (?:complies with|does not break) this rule: /s, '');
}

export type GateHost = Pick<GradeHost, 'forge' | 'fs' | 'judge' | 'store' | 'now' | 'notice'>;

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
  const subjects = await textRulesSubjects({ forge: host.forge, repo: checkout.repo, source: rulesOf(host, checkout), judge: host.judge, store: host.store, now: host.now, notice: host.notice }, { text: outbound.text, about: outbound.kind }, checkout.config);
  return { outbound, decision: await gateOutbound(outbound, subjects, pack, host.judge, checkout.config) };
}

// a directory in no repository has no rule documents of its own; entries the config names in another repository still read from the forge
function rulesOf(host: GateHost, checkout: Checkout): RuleSource {
  if (checkout.git || checkout.repo) return ruleSource(host, { checkout, named: false }, checkout.repo);
  return { scope: checkout.root, list: async () => [], read: async () => undefined, templates: async () => [], remote: (repo, path, ref) => host.forge.file(repo, path, ref) };
}
