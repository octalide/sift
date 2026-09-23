import { describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { GRACE_MS, Mailbox, ownerNotice, refusalOf, relayBlock, type AgentLike, type MailboxHost } from '../src/watch/mailbox.ts';
import type { WatchDelivery } from '../src/watch/watcher.ts';
import { memoryStore } from './fake-source.ts';

// a mailbox over a fake clock: timers fire only when the test advances it
function harness(agents: AgentLike[] = [], refuse?: string, store = memoryStore(), clock = { now: 1_000_000 }, gate: Promise<void> = Promise.resolve()) {
  const timers: { at: number; fn: () => Promise<void>; cancelled: boolean }[] = [];
  const submitted: string[] = [];
  const sent: { to: string; text: string }[] = [];
  const retired: string[] = [];
  const host: MailboxHost = {
    store,
    key: 'watch-mail:test',
    agents: async () => agents,
    now: () => clock.now,
    submit: async (text) => void submitted.push(text),
    send: async (to, text) => (sent.push({ to, text }), await gate, refuse),
    retire: async (agentId, why) => void retired.push(`${agentId}: ${why}`),
    schedule: (ms, fn) => {
      const t = { at: clock.now + ms, fn, cancelled: false };
      timers.push(t);
      return { cancel: () => void (t.cancelled = true) };
    },
    log: () => {},
  };
  const advance = async (ms: number) => {
    clock.now += ms;
    for (const t of timers.filter((t) => !t.cancelled && t.at <= clock.now)) {
      t.cancelled = true;
      await t.fn();
    }
  };
  return { mailbox: new Mailbox(host), submitted, sent, retired, advance, store, clock };
}

const delivery = (to: string | undefined, text = '[sift watch o/r]\nci settled success: pr #3'): WatchDelivery => ({ repo: 'o/r', ...(to ? { to } : {}), text, subscriptions: [] });

describe('mailbox', () => {
  it('submits a main-loop delivery as a prompt', async () => {
    const { mailbox, submitted, sent } = harness();
    await mailbox.deliver(delivery(undefined, 'hello'));
    expect(submitted).toEqual(['hello']);
    expect(sent).toEqual([]);
  });

  it('hands a running agent its delivery on its next tool call, and nowhere else', async () => {
    const { mailbox, submitted, sent, advance } = harness([{ id: 'a1', status: 'running' }]);
    await mailbox.deliver(delivery('a1', 'one'));
    await mailbox.deliver(delivery('a1', 'two'));
    expect(mailbox.pending()).toEqual([{ to: 'a1', count: 2 }]);
    // another agent's tool call takes nothing
    expect(await mailbox.take('a2')).toEqual([]);
    expect(await mailbox.take('a1')).toEqual(['one', 'two']);
    expect(await mailbox.take('a1')).toEqual([]);
    // the grace passing afterwards sends nothing: the piggyback consumed it
    await advance(GRACE_MS);
    expect(sent).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it('sends a running agent its delivery by SendMessage once the grace passes without a tool call', async () => {
    const { mailbox, submitted, sent, advance } = harness([{ id: 'a1', status: 'running' }]);
    await mailbox.deliver(delivery('a1', 'one'));
    await advance(GRACE_MS - 1);
    expect(sent).toEqual([]);
    await mailbox.deliver(delivery('a1', 'two'));
    await advance(1);
    // one message, every waiting delivery complete, addressed by agentId, and gone from the mailbox
    expect(sent).toEqual([{ to: 'a1', text: 'one\n\ntwo' }]);
    expect(submitted).toEqual([]);
    expect(await mailbox.take('a1')).toEqual([]);
  });

  it('sends at once to an agent that has finished, listed as such or not listed at all', async () => {
    const { mailbox, sent } = harness([{ id: 'a1', status: 'completed' }, { id: 'a2', status: 'killed' }]);
    await mailbox.deliver(delivery('a1', 'one'));
    await mailbox.deliver(delivery('a3', 'three'));
    expect(sent).toEqual([{ to: 'a1', text: 'one' }, { to: 'a3', text: 'three' }]);
    expect(mailbox.pending()).toEqual([]);
  });

  it('relays a refused SendMessage to the main loop in a fixed block and retires the agent\'s subscriptions', async () => {
    const { mailbox, submitted, retired } = harness([], 'no agent named a9');
    await mailbox.deliver(delivery('a9', '[sift watch o/r]\nci settled failure: pr #9 feat/9 @abc1234: Feat 9 (2 checks, failed: test)\n  by me · https://x/pull/9 · ci settled on pr · s4'));
    expect(submitted).toEqual([
      [
        '[sift watch relay] to: a9',
        'SendMessage refused: no agent named a9',
        '[sift watch o/r]',
        'ci settled failure: pr #9 feat/9 @abc1234: Feat 9 (2 checks, failed: test)',
        '  by me · https://x/pull/9 · ci settled on pr · s4',
      ].join('\n'),
    ]);
    expect(retired).toEqual(['a9: SendMessage refused: no agent named a9']);
    expect(relayBlock('a1', 'r', 't')).toBe('[sift watch relay] to: a1\nSendMessage refused: r\nt');
  });

  it('reads a refusal from what the engine answered a SendMessage with', () => {
    expect(refusalOf({ result: { success: true, message: 'Resuming agent a1' } })).toBeUndefined();
    expect(refusalOf({ result: { success: true, message: 'Message queued for delivery to a1 at its next tool round.' } })).toBeUndefined();
    expect(refusalOf({ deny: 'blocked by policy' })).toBe('blocked by policy');
    expect(refusalOf({ isError: true, text: 'No agent a1' })).toBe('No agent a1');
    expect(refusalOf({ result: { success: false, message: 'agent is gone' } })).toBe('agent is gone');
  });

  it('keeps undelivered deliveries across a reload, their grace counted from when they arrived', async () => {
    const store = memoryStore();
    const clock = { now: 1_000_000 };
    const first = harness([{ id: 'a1', status: 'running' }], undefined, store, clock);
    await first.mailbox.deliver(delivery('a1', 'one'));
    clock.now += 20_000;
    const again = harness([{ id: 'a1', status: 'running' }], undefined, store, clock);
    await again.mailbox.load();
    expect(again.mailbox.pending()).toEqual([{ to: 'a1', count: 1 }]);
    await again.advance(GRACE_MS - 20_000);
    expect(again.sent).toEqual([{ to: 'a1', text: 'one' }]);
  });

  it('stops its timers and waits for a timed send in flight', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = harness([{ id: 'a1', status: 'running' }, { id: 'a2', status: 'running' }], 'gone', memoryStore(), { now: 1_000_000 }, gate);
    await h.mailbox.deliver(delivery('a1', 'one'));
    const firing = h.advance(GRACE_MS);
    await h.mailbox.deliver(delivery('a2', 'two'));
    let stopped = false;
    const stopping = h.mailbox.stop().then(() => void (stopped = true));
    await setImmediate();
    // a1's send is still out, so the stop has not resolved
    expect(stopped).toBe(false);
    release();
    await Promise.all([firing, stopping]);
    expect(h.retired).toEqual(['a1: SendMessage refused: gone']);
    // a2's grace timer went with the stop
    await h.advance(GRACE_MS);
    expect(h.sent).toEqual([{ to: 'a1', text: 'one' }]);
    expect(h.mailbox.pending()).toEqual([{ to: 'a2', count: 1 }]);
  });

  it('tells a subagent that subscribed where its deliveries arrive and not to wait for them', () => {
    const notice = ownerNotice('a1');
    expect(notice).toContain('(a1)');
    expect(notice).toContain('next tool call');
    expect(notice).toContain('resumes you');
    expect(notice).toContain('Do not wait or poll');
  });
});
