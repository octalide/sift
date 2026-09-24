// the kinds of text a rule can govern, each as the judge reads it. forge-neutral: a merge request is a pr, a note on
// one a comment. a new kind is a new entry here, asked of every rule at its next discovery
export const TEXT_KINDS = {
  issue: 'an issue: its title and body, the problem or change it asks for',
  pr: 'a pull request: its title and body, the branch it merges from, the branch it targets and whether it is a draft',
  comment: 'a comment or review on an issue or pull request',
  commit: 'a commit message, a merge commit among them',
  release: 'a release: its tag, title and notes',
  message: 'a message outside the code host, such as a chat message, an announcement or a direct message',
} as const;

export type TextKind = keyof typeof TEXT_KINDS;

export const TEXT_KIND_NAMES = Object.keys(TEXT_KINDS) as TextKind[];

export function isTextKind(v: unknown): v is TextKind {
  return typeof v === 'string' && Object.hasOwn(TEXT_KINDS, v);
}
