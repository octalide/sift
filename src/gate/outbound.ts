import type { Judge } from '../judge/types.ts';
import { runPack } from '../packs/run.ts';
import type { Pack, Report, Subject } from '../packs/types.ts';
import type { RepoConfig } from '../github/config.ts';
import type { Forge, ForgeAction, ForgeArtifact } from '../forge/forge.ts';

// text a tool call is about to send somewhere people read, the hard limit of that channel, and which artifact it is;
// denied names the reason the text could not be obtained at all, which the gate refuses without a judge call
export type Outbound = { channel: string; text: string; maxChars?: number; kind?: ForgeArtifact; action?: ForgeAction; denied?: string };

// what a call carries: the text itself, or the file it will be read from
export type Body = { text: string } | { file: string };
type Extracted = Pick<Outbound, 'kind' | 'action'> & Body;
export type Extractor = { channel: string; maxChars?: number; extract: (tool: string, input: Record<string, unknown>) => Extracted | undefined };
export type ReadText = (path: string) => Promise<string>;

const DISCORD_LIMIT = 2000;
const DISCORD_TOOLS: Record<string, string[]> = {
  mcp__discord__send_message: ['content'],
  mcp__discord__send_dm: ['content', 'message'],
  mcp__discord__edit_message: ['content'],
  mcp__discord__send_webhook_message: ['content'],
  mcp__discord__create_forum_post: ['content', 'message'],
  mcp__discord__send_embed: ['description', 'title'],
  mcp__discord__send_dm_embed: ['description', 'title'],
};

export const DISCORD: Extractor = {
  channel: 'discord',
  maxChars: DISCORD_LIMIT,
  extract: (tool, input) => {
    const fields = DISCORD_TOOLS[tool];
    if (!fields) return undefined;
    const parts = fields.map((f) => input[f]).filter((v): v is string => typeof v === 'string' && v.length > 0);
    return parts.length > 0 ? { text: parts.join('\n') } : undefined;
  },
};

// a bash command that writes an artifact through the forge's cli; the forge reads its own flags
export function forgeExtractor(forge: Forge): Extractor {
  return {
    channel: forge.name.toLowerCase(),
    extract: (tool, input) => {
      if (tool !== 'Bash') return undefined;
      const write = forge.write(String(input['command'] ?? ''));
      if (!write || write.body === undefined) return undefined;
      return { ...write.body, kind: write.kind, action: write.action };
    },
  };
}

export function extractors(forge?: Forge): Extractor[] {
  return forge ? [DISCORD, forgeExtractor(forge)] : [DISCORD];
}

// a body named by file is read here so the gate judges exactly what the command will send
export async function outboundOf(tool: string, input: Record<string, unknown>, read: ReadText, through: Extractor[] = extractors()): Promise<Outbound | undefined> {
  for (const x of through) {
    const got = x.extract(tool, input);
    if (got === undefined) continue;
    const { kind, action } = got;
    const base = { channel: x.channel, maxChars: x.maxChars, kind, action };
    if ('text' in got) return { ...base, text: got.text };
    if (got.file === '-') return { ...base, text: '', denied: 'the body is read from stdin (--body-file -), which cannot be judged; pass --body or a file path' };
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
  if (out.maxChars !== undefined && out.text.length > out.maxChars) {
    return { allow: false, reason: `${out.channel} text is ${out.text.length} chars, the limit is ${out.maxChars}`, warnings: [] };
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
