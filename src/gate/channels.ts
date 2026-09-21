import type { Forge, ForgeAction, ForgeArtifact } from '../forge/forge.ts';
import { shellWord } from '../shell.ts';

// where the text is in a call: fields of the tool input, joined in order; or for a shell command, the
// command pattern, the flags carrying the text inline (a quoted word, or a $(cat <<'EOF' ... EOF) heredoc)
// and the flags naming a file it is read from
export type TextSource = { fields: string[] } | { command: string; body: string[]; file?: string[] };

// one place text leaves the session: a name config replaces it by, a regex over the tool name, where the
// text is, the channel's hard length limit, and what the text is in the words a rules question names it by
export type Channel = { name: string; tool: string; text: TextSource; limit?: number; kind?: string };

// what a call carries: the text itself, or the file it will be read from
export type Body = { text: string } | { file: string };

const DISCORD_LIMIT = 2000;

export const DISCORD_CHANNELS: Channel[] = [
  { name: 'discord-message', tool: '^mcp__discord__(send_message|edit_message|send_webhook_message)$', text: { fields: ['content'] }, limit: DISCORD_LIMIT, kind: 'a Discord message' },
  { name: 'discord-dm', tool: '^mcp__discord__send_dm$', text: { fields: ['content', 'message'] }, limit: DISCORD_LIMIT, kind: 'a Discord direct message' },
  { name: 'discord-forum-post', tool: '^mcp__discord__create_forum_post$', text: { fields: ['content', 'message'] }, limit: DISCORD_LIMIT, kind: 'a Discord forum post' },
  { name: 'discord-embed', tool: '^mcp__discord__(send_embed|send_dm_embed)$', text: { fields: ['description', 'title'] }, limit: DISCORD_LIMIT, kind: 'a Discord embed' },
];

// how an artifact is named when no forge is bound to name it
const PLAIN_NOUNS: Record<ForgeArtifact, string> = { issue: 'issue', pr: 'pull request', release: 'release' };

// what the text is, in the words the judge reads: "the body of a new GitHub issue"
export function textAbout(artifact: { kind: ForgeArtifact; action: ForgeAction }, nouns: Record<ForgeArtifact, string> = PLAIN_NOUNS): string {
  const noun = nouns[artifact.kind];
  if (artifact.action === 'comment') return `a comment on a ${noun}`;
  if (artifact.action === 'review') return `a review on a ${noun}`;
  if (artifact.action === 'merge') return 'a merge commit message';
  if (artifact.action === 'edit') return `the edited ${artifact.kind === 'release' ? 'notes' : 'body'} of a ${noun}`;
  return `the ${artifact.kind === 'release' ? 'notes' : 'body'} of a new ${noun}`;
}

// one channel per write the forge's cli makes, named forge-artifact-action
export function forgeChannels(forge: Forge): Channel[] {
  const prefix = forge.name.toLowerCase();
  return forge.writes.map((w) => ({ name: `${prefix}-${w.kind}-${w.action}`, tool: '^Bash$', text: { command: w.command, body: w.body, file: w.file }, kind: textAbout(w, forge.nouns) }));
}

export function defaultChannels(forge?: Forge): Channel[] {
  return forge ? [...DISCORD_CHANNELS, ...forgeChannels(forge)] : [...DISCORD_CHANNELS];
}

// an entry with a known name takes that entry's place in the order, any other is appended
export function channelTable(defaults: Channel[], over: Channel[]): Channel[] {
  const table = [...defaults];
  for (const c of over) {
    const at = table.findIndex((d) => d.name === c.name);
    if (at < 0) table.push(c);
    else table[at] = c;
  }
  return table;
}

const flagPattern = (flags: string[]): RegExp => new RegExp(String.raw`(?:^|\s)(?:${flags.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:=|\s+)`);

// a heredoc on the command's stdin: the lines between the << line and the delimiter alone on its own line
const STDIN_HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*(?:\n|$)/;

// the value after a body flag: a quoted word, or a heredoc inside $(cat <<'EOF' ... EOF); else the path after a file flag,
// or the heredoc on stdin when that path is -
export function commandBody(command: string, source: Extract<TextSource, { command: string }>): Body | undefined {
  const flag = flagPattern(source.body).exec(command);
  if (flag) {
    const rest = command.slice(flag.index + flag[0].length);
    const heredoc = /^"?\$\(\s*cat\s+<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\s*\n?\s*\)/.exec(rest);
    if (heredoc) return { text: heredoc[2]! };
    const text = shellWord(rest);
    return text === undefined ? undefined : { text };
  }
  if (!source.file || source.file.length === 0) return undefined;
  const fileFlag = flagPattern(source.file).exec(command);
  if (!fileFlag) return undefined;
  const file = shellWord(command.slice(fileFlag.index + fileFlag[0].length));
  if (file === undefined) return undefined;
  if (file !== '-') return { file };
  const stdin = STDIN_HEREDOC.exec(command);
  return stdin ? { text: stdin[2]! } : { file };
}

// the text a call sends through the channel, undefined when the call is not on it or carries none
export function textOf(channel: Channel, tool: string, input: Record<string, unknown>): Body | undefined {
  if (!new RegExp(channel.tool).test(tool)) return undefined;
  if ('fields' in channel.text) {
    const parts = channel.text.fields.map((f) => input[f]).filter((v): v is string => typeof v === 'string' && v.length > 0);
    return parts.length > 0 ? { text: parts.join('\n') } : undefined;
  }
  const command = input['command'];
  if (typeof command !== 'string' || !new RegExp(channel.text.command).test(command)) return undefined;
  return commandBody(command, channel.text);
}
