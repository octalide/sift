import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/github/config.ts';
import type { Judge } from '../src/judge/types.ts';
import { gateOutbound, ghBody, outboundOf, shellWord } from '../src/gate/outbound.ts';
import { BUILTIN_PACKS } from '../src/packs/builtin.ts';
import type { Subject } from '../src/packs/types.ts';

describe('outbound extraction', () => {
  it('reads discord content and embed text', () => {
    expect(outboundOf('mcp__discord__send_message', { channel_id: '1', content: 'hello' })).toEqual({ channel: 'discord', text: 'hello', maxChars: 2000 });
    expect(outboundOf('mcp__discord__send_embed', { title: 'T', description: 'D' })).toMatchObject({ text: 'D\nT' });
    expect(outboundOf('mcp__discord__list_channels', {})).toBeUndefined();
    expect(outboundOf('Write', { content: 'x' })).toBeUndefined();
  });

  it('reads gh bodies from quoted words and heredocs', () => {
    expect(shellWord(`'it''s'`)).toBe('it');
    expect(shellWord(`"a \\"quoted\\" word" tail`)).toBe('a "quoted" word');
    expect(shellWord('bare rest')).toBe('bare');
    expect(ghBody(`gh pr create -B dev -t "t" -b "Closes #4\\nbody" --draft`)).toBe('Closes #4\\nbody');
    expect(ghBody(`gh issue comment 3 --body='single'`)).toBe('single');
    expect(ghBody(`gh pr create -t "t" -b "$(cat <<'EOF'\n## Summary\n\nline two\nEOF\n)"`)).toBe('## Summary\n\nline two');
    expect(ghBody('gh pr create --fill')).toBeUndefined();
    expect(outboundOf('Bash', { command: 'gh pr comment 5 -b "looks good"' })).toEqual({ channel: 'github', text: 'looks good', maxChars: undefined });
    expect(outboundOf('Bash', { command: 'gh pr view 5 --json body' })).toBeUndefined();
    expect(outboundOf('Bash', { command: 'gh release create v1 --notes "n"' })).toBeUndefined();
  });
});

describe('outbound gate', () => {
  const rules = [{ source: 'CLAUDE.md', text: 'No em dashes.' }, { source: 'CLAUDE.md', text: 'Terse by default.' }];
  const subject: Subject = { kind: 'rules', ref: 'text', state: { subject: { kind: 'text', text: 'x' }, rules }, facts: { rules, has_rules: true, total_rules: 2 }, options: {} };
  const judge = (p: number[]): Judge => ({
    name: 'fake',
    ask: async (_s, q) => ({ ok: true, backend: 'fake', latencyMs: 1, answers: Object.fromEntries(Object.keys(q).map((k, i) => [k, { type: 'noul' as const, p: p[i] ?? 0.9 }])) }),
  });
  const pack = BUILTIN_PACKS['rules']!;

  it('denies over the channel limit without asking the judge', async () => {
    const d = await gateOutbound({ channel: 'discord', text: 'x'.repeat(2001), maxChars: 2000 }, subject, pack, judge([]), DEFAULT_CONFIG);
    expect(d).toMatchObject({ allow: false, reason: 'discord text is 2001 chars, the limit is 2000' });
    expect(d.report).toBeUndefined();
  });

  it('denies a broken rule, warns on an unclear one, allows the rest', async () => {
    const broken = await gateOutbound({ channel: 'github', text: 'a — b' }, subject, pack, judge([0.1, 0.9]), DEFAULT_CONFIG);
    expect(broken).toMatchObject({ allow: false, reason: 'breaks: No em dashes.', warnings: [] });
    const unclear = await gateOutbound({ channel: 'github', text: 'ok' }, subject, pack, judge([0.9, 0.5]), DEFAULT_CONFIG);
    expect(unclear).toMatchObject({ allow: true, reason: 'clear', warnings: ['unclear: Terse by default.'] });
    const off: Judge = { name: 'off', ask: async () => ({ ok: false, reason: 'disabled', message: 'off', backend: 'off' }) };
    expect((await gateOutbound({ channel: 'github', text: 'ok' }, subject, pack, off, DEFAULT_CONFIG)).allow).toBe(true);
  });
});
