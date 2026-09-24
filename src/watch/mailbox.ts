import type { StoreLike } from '../log.ts';
import type { WatchDelivery } from './watcher.ts';

// one agent as the engine lists it: status is running until it completes, fails or is killed
export type AgentLike = { id: string; status: string };

export type MailboxHost = {
  store: StoreLike;
  // the store key the undelivered letters persist under
  key: string;
  agents: () => Promise<AgentLike[]>;
  now: () => number;
  // a prompt to the session's main loop
  submit: (text: string) => Promise<void>;
  // a SendMessage raised by the plugin to the agent by agentId: undefined once the engine took it, else why it refused
  send: (to: string, text: string) => Promise<string | undefined>;
  // retires every subscription the agent owns
  retire: (agentId: string, why: string) => Promise<void>;
  // runs fn once after ms; what it returns settles when the delivery has gone
  schedule: (ms: number, fn: () => Promise<void>) => { cancel: () => void };
  log: (text: string) => void;
};

// how long a delivery waits for its running owner's next tool call before it goes by SendMessage
export const GRACE_MS = 60_000;

const FINISHED = new Set(['completed', 'failed', 'killed']);

type Letter = { to: string; text: string; at: number };

// the channels a delivery reaches its recipient by. the main loop's is a prompt. an agent's rides its next tool call
// (take), or once the grace passes or the agent has finished, a SendMessage the plugin raises, which resumes a
// finished agent. a SendMessage the engine refuses goes to the main loop as a relay block and retires the agent's
// subscriptions, since nothing can reach it any more
export class Mailbox {
  private letters: Letter[] = [];
  private readonly timers = new Map<string, { cancel: () => void }>();
  private readonly flushing = new Set<Promise<void>>();

  constructor(private readonly host: MailboxHost) {}

  // restores the letters a reload left undelivered, each agent's grace counted from its oldest
  async load(): Promise<void> {
    this.letters = ((await this.host.store.get(this.host.key)) as Letter[] | undefined) ?? [];
    for (const to of new Set(this.letters.map((l) => l.to))) {
      const oldest = Math.min(...this.letters.filter((l) => l.to === to).map((l) => l.at));
      this.arm(to, Math.max(0, oldest + GRACE_MS - this.host.now()));
    }
  }

  // a watch delivery, or anything else that follows a call once it is known: the main loop's when to is unset
  async deliver(d: Pick<WatchDelivery, 'to' | 'text'>): Promise<void> {
    if (d.to === undefined) return this.host.submit(d.text);
    this.letters.push({ to: d.to, text: d.text, at: this.host.now() });
    await this.save();
    if (await this.finished(d.to)) return this.flush(d.to);
    this.arm(d.to, GRACE_MS);
  }

  // what waits for the agent, taken so it rides the result of the tool call it is making now
  async take(agentId: string): Promise<string[]> {
    const mine = this.letters.filter((l) => l.to === agentId);
    if (mine.length === 0) return [];
    this.timers.get(agentId)?.cancel();
    this.timers.delete(agentId);
    this.letters = this.letters.filter((l) => l.to !== agentId);
    await this.save();
    return mine.map((l) => l.text);
  }

  // cancels every grace timer and resolves once no timed flush is mid-send; the letters stay where they are
  async stop(): Promise<void> {
    for (const t of this.timers.values()) t.cancel();
    this.timers.clear();
    await Promise.all(this.flushing);
  }

  pending(): { to: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const l of this.letters) counts.set(l.to, (counts.get(l.to) ?? 0) + 1);
    return [...counts.entries()].map(([to, count]) => ({ to, count }));
  }

  private arm(to: string, ms: number): void {
    if (this.timers.has(to)) return;
    this.timers.set(
      to,
      this.host.schedule(ms, () => {
        const f = this.flush(to).finally(() => void this.flushing.delete(f));
        this.flushing.add(f);
        return f;
      }),
    );
  }

  private async flush(to: string): Promise<void> {
    const texts = await this.take(to);
    if (texts.length === 0) return;
    const text = texts.join('\n\n');
    let refused: string | undefined;
    try {
      refused = await this.host.send(to, text);
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    if (refused === undefined) return;
    this.host.log(`sift watch: SendMessage to ${to} refused (${refused}), relayed to the main loop`);
    await this.host.submit(relayBlock(to, refused, text));
    await this.host.retire(to, `SendMessage refused: ${refused}`);
  }

  // listed as completed, failed or killed, or not listed at all (a finished foreground agent is not)
  private async finished(agentId: string): Promise<boolean> {
    const agent = (await this.host.agents()).find((a) => a.id === agentId);
    return agent === undefined || FINISHED.has(agent.status);
  }

  private async save(): Promise<void> {
    await this.host.store.set(this.host.key, this.letters);
  }
}

// a delivery the engine would not SendMessage, for the main loop: the recipient, why it was refused, the text complete
export function relayBlock(to: string, refused: string, text: string): string {
  return [`[sift watch relay] to: ${to}`, `SendMessage refused: ${refused}`, text].join('\n');
}

// why the engine refused a SendMessage, from what $.tool.call resolved to; undefined when it took it
export function refusalOf(r: { deny?: string; isError?: boolean; text?: string; result?: unknown }): string | undefined {
  if (r.deny !== undefined) return r.deny;
  if (r.isError) return r.text || 'SendMessage failed';
  const result = r.result as { success?: boolean; message?: string } | undefined;
  if (result?.success === false) return result.message || 'SendMessage did not succeed';
  return undefined;
}

// what a subagent that subscribed is told: where its deliveries arrive, and that it need not stay awake for them
export function ownerNotice(agentId: string): string {
  return `subscribed for this agent (${agentId}). A delivery arrives with the result of your next tool call. If you make none within ${GRACE_MS / 1000} s, or have ended your turn, it arrives as a message that resumes you. Do not wait or poll for it: carry on, or end your turn.`;
}
