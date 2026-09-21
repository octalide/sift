import type { CwdLike, RunLike } from '../process.ts';

// a git command in the checkout: stdout on success, throws on a nonzero exit
export type Git = (args: string[]) => Promise<string>;

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

export function localGit(run: RunLike, cwd: CwdLike = async () => undefined): Git {
  return async (args) => {
    const result = await run(['git', ...args], { cwd: await cwd(), timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new GitError(`git ${args.join(' ')}: ${result.stderr.trim()}`, result.exitCode);
    return result.stdout;
  };
}
