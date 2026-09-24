import type { Forge, ForgePost, ForgeWrite, MergeMethod, ReviewVerdict } from '../forge/forge.ts';
import type { Judge } from '../judge/types.ts';
import type { Pack } from '../packs/types.ts';
import type { RepoConfig } from '../repo/config.ts';
import { textRulesSubjects } from '../repo/subjects.ts';
import { forgeSource, type Discoveries } from '../rules/discover.ts';
import { simpleCommands } from '../shell.ts';
import { channelTable, defaultChannels, POST_TOOL, postKind, textAbout } from './channels.ts';
import { enact, gateOutbound, outboundOf, settleDecision, verdictLater, verdictOf, type Later, type Outbound, type OutboundDecision, type OutboundMode } from './outbound.ts';
import type { Verdicts } from './verdicts.ts';

export const VERDICTS: ReviewVerdict[] = ['approve', 'request-changes', 'comment'];
export const METHODS: MergeMethod[] = ['merge', 'squash', 'rebase'];

// the post tool's input, as the model sends it
export type PostInput = {
  repo?: unknown;
  kind?: unknown;
  number?: unknown;
  tag?: unknown;
  title?: unknown;
  body?: unknown;
  base?: unknown;
  head?: unknown;
  draft?: unknown;
  verdict?: unknown;
  method?: unknown;
  target?: unknown;
  prerelease?: unknown;
  override?: unknown;
};

// the repository and the write a post names, or what is missing or malformed in it
export function postOf(input: PostInput, forge: Pick<Forge, 'writes'>): { repo: string; post: ForgePost; override?: string } | { error: string } {
  const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
  if (!/^[^/\s]+\/[^\s]+$/.test(repo)) return { error: `repo is the repository to write to as owner/name, got ${JSON.stringify(input.repo)}` };
  const kinds = forge.writes.map(postKind);
  const write = forge.writes.find((w) => postKind(w) === input.kind);
  if (!write) return { error: `kind is one of ${kinds.join(', ')}, got ${JSON.stringify(input.kind)}` };
  const str = (k: keyof PostInput): string | undefined => (typeof input[k] === 'string' && (input[k] as string).length > 0 ? (input[k] as string) : undefined);
  const bool = (k: keyof PostInput): boolean | undefined => (typeof input[k] === 'boolean' ? (input[k] as boolean) : undefined);
  const missing = (...names: string[]) => ({ error: `${input.kind} needs ${names.join(' and ')}` });
  const number = typeof input.number === 'number' ? input.number : typeof input.number === 'string' && /^#?\d+$/.test(input.number) ? Number(input.number.replace('#', '')) : undefined;
  const numbered = write.kind !== 'release' && write.action !== 'create';
  if (numbered && (number === undefined || !Number.isInteger(number) || number <= 0)) return missing('number, the issue or pull request number');
  const tag = str('tag');
  if (write.kind === 'release' && tag === undefined) return missing('tag');
  const [title, body] = [str('title'), str('body')];
  const post = ((): ForgePost | { error: string } => {
    switch (write.action) {
      case 'create':
        if (write.kind === 'release') return body === undefined ? missing('body, the release notes') : { kind: 'release', action: 'create', tag: tag!, body, title, target: str('target'), draft: bool('draft'), prerelease: bool('prerelease') };
        if (title === undefined || body === undefined) return missing('title', 'body');
        if (write.kind === 'issue') return { kind: 'issue', action: 'create', title, body };
        if (str('base') === undefined || str('head') === undefined) return missing('base', 'head');
        return { kind: 'pr', action: 'create', title, body, base: str('base')!, head: str('head')!, draft: bool('draft') };
      case 'comment':
        return body === undefined ? missing('body') : { kind: write.kind as 'issue' | 'pr', action: 'comment', number: number!, body };
      case 'edit':
        if (title === undefined && body === undefined) return missing('title or body');
        return write.kind === 'release' ? { kind: 'release', action: 'edit', tag: tag!, title, body } : { kind: write.kind, action: 'edit', number: number!, title, body };
      case 'review': {
        const verdict = VERDICTS.find((v) => v === input.verdict);
        if (!verdict) return { error: `pr-review needs verdict, one of ${VERDICTS.join(', ')}` };
        return { kind: 'pr', action: 'review', number: number!, verdict, body };
      }
      case 'merge': {
        const method = METHODS.find((m) => m === input.method);
        if (!method) return { error: `pr-merge needs method, one of ${METHODS.join(', ')}` };
        return { kind: 'pr', action: 'merge', number: number!, method, title, body };
      }
    }
  })();
  if ('error' in post) return post;
  if (input.override !== undefined && (typeof input.override !== 'string' || input.override.trim().length === 0)) return { error: `override is the reason the write goes through over the ruling, got ${JSON.stringify(input.override)}` };
  return typeof input.override === 'string' ? { repo, post, override: input.override.trim() } : { repo, post };
}

export type PostHost = {
  forge: Forge;
  judge: Judge;
  // the rule discoveries in flight, shared with every grade of the session
  discoveries: Discoveries;
  // the gate's kept verdicts, shared with every gate of the session
  verdicts: Verdicts;
  // the conventions of a repository on the forge
  config: (repo: string) => Promise<RepoConfig>;
  // keeps a post held while its rules are found, answering the claim to make before writing it: false once a reload
  // handed the post to the environment that replaced this one. unset, a held post is only held in memory
  hold?: (input: PostInput) => Promise<() => Promise<boolean>>;
};

// action is what the decision log records, verdict what an advised or overridden write carries back to the caller.
// held: the write waits for its rules; later settles to what the caller is told once they are known, the advice on a
// write made at once or the outcome of a held one
export type Posted = { outbound?: Outbound; decision?: OutboundDecision; action?: string; override?: string; later?: Promise<Later> } & ({ url: string; verdict?: string } | { refused: string } | { held: string });

const noFile = async (): Promise<string> => {
  throw new Error('the post tool takes its text inline');
};

// one post under the repository it names: that repository's conventions, channels and rule documents, read from the
// forge whatever the caller's working directory is. the mode decides what a limit or a broken rule does: off judges
// nothing, advise writes with the verdict attached, enforce refuses unless the post carries an override. when the
// rules are still being found, advise writes at once and the verdict follows in later, and enforce holds the write
// until they are, so the caller never sends the text twice
export async function postCall(host: PostHost, pack: Pack | undefined, input: PostInput, mode: OutboundMode, shadow = false): Promise<Posted> {
  const parsed = postOf(input, host.forge);
  if ('error' in parsed) return { refused: parsed.error };
  const { repo, post, override } = parsed;
  if (mode === 'off') return { url: await host.forge.post(repo, post) };
  const config = await host.config(repo);
  const outbound = await outboundOf(POST_TOOL, input as Record<string, unknown>, noFile, channelTable(defaultChannels(host.forge), config.outbound.channels));
  if (!outbound || !pack) return { outbound, url: await host.forge.post(repo, post) };
  const judged = async () => gateOutbound(outbound, await textRulesSubjects({ forge: host.forge, repo, source: forgeSource(host.forge, repo), discoveries: host.discoveries }, { text: outbound.text, about: outbound.kind }, config), pack, host.judge, config, host.verdicts);
  const decision = await judged();
  const { action, refuse, advise } = enact(mode, decision, shadow, override);
  const label = postLabel(repo, post, String(input.kind));
  if (decision.pending && !shadow && action !== 'override') {
    if (mode === 'advise') {
      const url = await host.forge.post(repo, post);
      const later = verdictLater(mode, outbound, decision, judged, `sift outbound advice on the ${label} written at ${url}, now that its rules are known`);
      return { outbound, decision, action, url, later, verdict: pendingNote(outbound, repo) };
    }
    const claim = host.hold ? await host.hold(input) : async () => true;
    const later = settleDecision(decision, judged).then(
      async (d): Promise<Later> => {
        if (!(await claim())) return { decision: d, action: 'handed-over', text: `sift post handed the held ${label} to the environment that replaced this one on a reload`, handedOver: true };
        const done = enact(mode, d, shadow);
        if (done.refuse) return { decision: d, action: done.action, text: `sift post refused the held ${label}, and nothing was written: ${outbound.channel} to ${repo}: ${d.reason}. Rewrite the text, or post again with override set to the reason it should go through as written.` };
        return { decision: d, action: done.action, text: `sift post wrote the held ${label}: ${await host.forge.post(repo, post)}` };
      },
    ).catch((error: unknown): Later => ({ action: 'fail', text: `sift post failed on the held ${label}: ${messageOf(error)}` }));
    return { outbound, decision, action: 'hold', later, held: `the ${label} is held while the rules of ${repo} are still being found. It is judged and written once they are known, and the url or the refusal follows` };
  }
  if (refuse) return { outbound, decision, action, refused: `${outbound.channel} to ${repo}: ${decision.reason}` };
  const url = await host.forge.post(repo, post);
  if (action === 'override') return { outbound, decision, action, override, url, verdict: `sift outbound (${outbound.channel}): written over the ruling (${decision.reason}), override: ${override}` };
  return { outbound, decision, action, url, ...(advise ? { verdict: verdictOf(outbound, decision) } : {}) };
}

// the write a post makes, for the caller told of it later: its kind and what it is on
export function postLabel(repo: string, post: ForgePost, kind: string): string {
  if (post.kind === 'release') return `${kind} ${post.tag} on ${repo}`;
  if (post.action === 'create') return `${kind} "${post.title}" on ${repo}`;
  return `${kind} on ${repo}#${post.number}`;
}

// what text sent before its rules were known carries back at once, scope naming whose rules
export function pendingNote(out: Outbound, scope: string): string {
  return `sift outbound (${out.channel}): the rules of ${scope} are still being found, so the text went out unjudged and the advice on it follows once they are known`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// the first write in a shell command the forge's own cli or api makes with text people read
export function rawWriteOf(forge: Pick<Forge, 'writeOf'>, command: string): ForgeWrite | undefined {
  for (const words of simpleCommands(command)) {
    const write = forge.writeOf(words);
    if (write) return write;
  }
  return undefined;
}

// why the shell write is refused and the post call that makes it instead
export function rawWriteRefusal(forge: Pick<Forge, 'name' | 'nouns'>, write: ForgeWrite): string {
  const target = write.kind === 'release' ? 'tag' : write.action === 'create' ? undefined : 'number';
  const fields = ['repo: "owner/name"', `kind: "${postKind(write)}"`, ...(target ? [target] : []), 'title and body as the write takes them'];
  return `this command writes ${textAbout(write, forge.nouns)} through the ${forge.name} cli or api, and sift refuses outbound ${forge.name} writes from the shell. Make it with the ${POST_TOOL} tool (${fields.join(', ')}), which judges the text by the rules of the repository it names and writes it there`;
}
