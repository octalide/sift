import type { Judge } from '../judge/types.ts';
import { runPack } from '../packs/run.ts';
import type { Pack, Report, Subject } from '../packs/types.ts';
import type { RepoConfig } from '../github/config.ts';
import type { GhAction, GhArtifact } from '../github/subjects.ts';

// text a tool call is about to send somewhere people read, the hard limit of that channel, and which artifact it is
export type Outbound = { channel: string; text: string; maxChars?: number; kind?: GhArtifact; action?: GhAction };

type Extracted = Pick<Outbound, 'text' | 'kind' | 'action'>;
type Extractor = { channel: string; maxChars?: number; extract: (tool: string, input: Record<string, unknown>) => Extracted | undefined };

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

const GH_WRITE = /^\s*gh\s+(pr|issue|release)\s+(create|comment|edit)\b/;

// the value after --body or -b: a quoted word, or a heredoc inside $(cat <<'EOF' ... EOF)
export function ghBody(command: string): string | undefined {
  const flag = /(?:^|\s)(?:--body|-b)(?:=|\s+)/.exec(command);
  if (!flag) return undefined;
  const rest = command.slice(flag.index + flag[0].length);
  const heredoc = /^"?\$\(\s*cat\s+<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\s*\n?\s*\)/.exec(rest);
  if (heredoc) return heredoc[2];
  return shellWord(rest);
}

// one shell word: single quotes verbatim, double quotes with backslash escapes, else up to whitespace
export function shellWord(text: string): string | undefined {
  if (text.length === 0) return undefined;
  const q = text[0];
  if (q === "'") {
    const end = text.indexOf("'", 1);
    return end < 0 ? text.slice(1) : text.slice(1, end);
  }
  if (q === '"') {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === '\\' && i + 1 < text.length && '$`"\\\n'.includes(text[i + 1]!)) {
        out += text[++i];
        continue;
      }
      if (c === '"') return out;
      out += c;
    }
    return out;
  }
  return /^\S+/.exec(text)?.[0];
}

export const EXTRACTORS: Extractor[] = [
  {
    channel: 'discord',
    maxChars: DISCORD_LIMIT,
    extract: (tool, input) => {
      const fields = DISCORD_TOOLS[tool];
      if (!fields) return undefined;
      const parts = fields.map((f) => input[f]).filter((v): v is string => typeof v === 'string' && v.length > 0);
      return parts.length > 0 ? { text: parts.join('\n') } : undefined;
    },
  },
  {
    channel: 'github',
    extract: (tool, input) => {
      if (tool !== 'Bash') return undefined;
      const command = String(input['command'] ?? '');
      const m = GH_WRITE.exec(command);
      if (!m) return undefined;
      const text = ghBody(command);
      return text === undefined ? undefined : { text, kind: m[1] as GhArtifact, action: m[2] as GhAction };
    },
  },
];

export function outboundOf(tool: string, input: Record<string, unknown>, extractors = EXTRACTORS): Outbound | undefined {
  for (const x of extractors) {
    const got = x.extract(tool, input);
    if (got !== undefined) return { channel: x.channel, maxChars: x.maxChars, ...got };
  }
  return undefined;
}

export type OutboundDecision = { allow: boolean; reason: string; report?: Report; warnings: string[] };

// the channel's length limit is mechanical; the rules are judged, a violated rule denies, an unclear one warns
export async function gateOutbound(out: Outbound, subject: Subject, pack: Pack, judge: Judge, config: RepoConfig): Promise<OutboundDecision> {
  if (out.maxChars !== undefined && out.text.length > out.maxChars) {
    return { allow: false, reason: `${out.channel} text is ${out.text.length} chars, the limit is ${out.maxChars}`, warnings: [] };
  }
  const report = await runPack(pack, subject, judge, config);
  if (report.judgeError) return { allow: true, reason: `judge unavailable (${report.judgeError})`, report, warnings: [] };
  const rule = (id: string) => report.judged.find((j) => j.id === id)?.instructions.replace(/^The subject(?: \([^)]*\))? complies with this rule: /, '') ?? id;
  const violated = report.judged.filter((j) => j.band === 'violated' && j.severity !== 'info');
  const unclear = report.judged.filter((j) => j.band === 'unclear' && j.severity !== 'info');
  const warnings = unclear.map((j) => `unclear: ${rule(j.id)}`);
  if (violated.length > 0) return { allow: false, reason: `breaks: ${violated.map((j) => rule(j.id)).join(' | ')}`, report, warnings };
  return { allow: true, reason: 'clear', report, warnings };
}
