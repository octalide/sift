import type { Forge, ForgeWrite } from '../forge/forge.ts';
import type { Checkout } from '../repo/checkout.ts';
import { channelTable, POST_TOOL, shellChannels, textAbout } from './channels.ts';
import { gateText, outboundOf, type GateHost, type Gated, type ReadText } from './outbound.ts';
import { rawWriteRefusal } from './post.ts';

// what the gate does with a forge write from the shell. a loop that can call post is refused and pointed at it. one
// that cannot (spawned before post was registered, and a subagent keeps the tools it was spawned with) has its text
// judged by the checkout's rules instead, so the gate never refuses a write without a way through that the caller has
export type ShellGate =
  | { write: ForgeWrite; fallback: boolean; refused: string }
  | { write: ForgeWrite; fallback: true; gated?: Gated };

export async function gateShellWrite(host: GateHost, write: ForgeWrite, canPost: boolean, checkout: () => Promise<Checkout>, input: Record<string, unknown>, read: ReadText): Promise<ShellGate> {
  if (canPost) return { write, fallback: false, refused: rawWriteRefusal(host.forge, write) };
  const at = await checkout();
  const outbound = await outboundOf('Bash', input, read, channelTable(shellChannels(host.forge), at.config.outbound.channels));
  if (!outbound) return { write, fallback: true, refused: unreadable(host.forge, write) };
  return { write, fallback: true, gated: await gateText(host, at, outbound) };
}

// why the judged text was let through or not, for a loop that cannot call post
export function fallbackNote(forge: Pick<Forge, 'name'>): string {
  return `This loop started before sift registered ${POST_TOOL}, so it cannot call it: its ${forge.name} write from the shell was judged on its text by the checkout's rules instead of refused`;
}

function unreadable(forge: Pick<Forge, 'name' | 'nouns' | 'cliText'>, write: ForgeWrite): string {
  const cli = forge.cliText(write);
  return `this command writes ${textAbout(write, forge.nouns)} through the ${forge.name} cli or api, and this loop started before sift registered ${POST_TOOL}, so it cannot call it. Its text is judged by the checkout's rules instead, and could not be read from this command: make the write with the ${forge.name} cli, the text after ${cli.body[0]} as a quoted word or a $(cat <<'EOF' ... EOF) heredoc, or in a file named by ${cli.file[0]}`;
}
