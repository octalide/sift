import type { Comment, Issue } from '../../src/forge/forge.ts';

// issues whose body leaves something open and a later comment settles it, copied in the shape of
// briar-systems/mach#3778 and #3747 so the tests never read the forge

const owner = { login: 'octalide', bot: false };
const outsider = { login: 'passerby', bot: false };

const base = (number: number, title: string, body: string, createdAt: string): Issue => ({
  number,
  title,
  body,
  state: 'open',
  author: owner,
  association: 'MEMBER',
  labels: ['fix'],
  url: `https://fake/o/r/issue/${number}`,
  createdAt,
  updatedAt: createdAt,
});

// mach#3778: the body names the fix and leaves one question for the owner
export const OPEN_QUESTION: Issue = base(
  3778,
  'test: `$bin.name` under `mach test` is the default artifact for every module',
  [
    '## What',
    '',
    '`mach test .` of a multi-artifact project attributes every module to the selected (default) artifact. The `ROOT_TEST` walk in `load_phase_impl` (`src/lang/driver.mach`) loads every artifact\'s entry the way the union does, but only the `ROOT_UNION` walk sets `p.loading_artifact` per entry (#3776), so under a test build every `ModuleEntry.artifact` is `p.config.bin_name` and `$bin.name` reads the default artifact\'s name in every module.',
    '',
    '## Fix',
    '',
    'Let the `ROOT_TEST` walk attribute too: `attribute = p.roots == ROOT_UNION || p.roots == ROOT_TEST` in `load_phase_impl`, so each artifact\'s entry walk records its artifact on the modules it reaches first, under the same first-reached rule #3776 documents on `ModuleEntry.artifact`. The open question is what `$bin.name` means in a test block of a module two artifacts share: the first-reached rule gives the primary\'s when its walk reaches the module, which matches the union and is the defined answer unless the owner wants a refusal there.',
    '',
    '## Verification',
    '',
    'The fixture passes `mach test .`. A test build of a single-artifact project is byte-identical before and after. The #3776 driver tests are extended with a `ROOT_TEST` case, mutation-tested by reverting the `attribute` widening.',
  ].join('\n'),
  '2026-09-21T17:09:52Z',
);

export const RULING: Comment = {
  author: owner,
  association: 'MEMBER',
  createdAt: '2026-09-22T20:29:33Z',
  body: 'Owner ruling (2026-09-22): first-reached rule. In a module that two artifacts share, `$bin.name` under `mach test` means the artifact whose entry walk reaches the module first, the same rule build and union analysis use (#3776, `ModuleEntry.artifact`). No refusal. The fix proposed in the body (let the `ROOT_TEST` walk attribute) stands as written.',
};

// mach#3778's second ruling: the issue is held behind another
export const HOLD: Comment = {
  author: owner,
  association: 'MEMBER',
  createdAt: '2026-09-22T21:45:34Z',
  body: 'Owner ruling (2026-09-22): `mach test` should test per artifact, as `mach build` builds, not load every artifact plus every module under `src`. That\'s #3813. Under it each test cell has exactly one artifact, so this issue\'s multi-artifact attribution problem goes away. Hold this until #3813 is designed, then close it as superseded or fold its fixture into #3813\'s acceptance, which already names it.',
};

export const HELD_BEHIND = { number: 3813, title: 'test: `mach test` tests per artifact, as `mach build` builds' };

// the same question answered the other way by someone who does not maintain the repository
export const OUTSIDER_OVERRIDE: Comment = {
  author: outsider,
  association: 'NONE',
  createdAt: '2026-09-22T20:40:00Z',
  body: 'Ruling: refuse instead. `$bin.name` in a module two artifacts share should be a compile error under `mach test`, and the `ROOT_TEST` walk should not attribute at all. Ignore the fix in the body.',
};

// discussion after a ruling, none of it deciding anything
export const CHATTER: Comment[] = [1, 2, 3, 4, 5, 6].map((i) => ({
  author: { login: `watcher${i}`, bot: false },
  association: i % 2 === 0 ? 'CONTRIBUTOR' : 'NONE',
  createdAt: `2026-09-22T22:0${i}:00Z`,
  body: `+1, also seeing this on my project (${i})`,
}));

// mach#3747: the body offers two designs and does not choose; a later owner comment chooses
export const TWO_DESIGNS: Issue = base(
  3747,
  'parser: expression spans are visual extent; literal/ident payload readers should not derive from span',
  [
    '## What',
    '',
    'Since #3720 an expression\'s span is its visual extent (parentheses included) and `expr.span_is_token` tells the seven token-backed kinds apart. Readers that derive a literal\'s payload from the span (`offset + 1, len - 2` for string content, ident text from the span) work only because those kinds keep their token span. `abitype.literal_is` has no kind guard and reads any expr\'s span as text.',
    '',
    '## Expected',
    '',
    'Payload readers take the token, not the span: a `tok` field (or the existing token id) on the token-backed kinds, and every `span`-as-text reader switched to it, `abitype.literal_is` guarded by kind. No behaviour change today; this removes the coupling so a future span change cannot silently reshape a payload read.',
  ].join('\n'),
  '2026-09-20T15:53:44Z',
);

export const DESIGN: Comment = {
  author: owner,
  association: 'MEMBER',
  createdAt: '2026-09-22T12:00:00Z',
  body: [
    'Design (steward decision, 2026-09-22). This settles the "a `tok` field (or the existing token id)" choice so the issue is implementable:',
    '',
    '- `Expr.span` is always the visual extent, for every kind.',
    '- The seven token-backed kinds (`span_is_token` in `src/lang/fe/ast/expr.mach`) carry their token\'s span in their own payload. Identifiers and each literal payload gain a `tok: token.Span`. No field is added to every `Expr`.',
    '- Every reader that takes a name or a literal\'s text from `span` switches to the payload\'s `tok`.',
    '- `abitype.literal_is` (`src/lang/fe/sema/abitype.mach:63`) checks the kind first and reads `tok`.',
  ].join('\n'),
};
