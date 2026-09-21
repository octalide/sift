import { describe, expect, it } from 'vitest';
import { localGit } from '../src/forge/git.ts';
import { Gh } from '../src/github/gh.ts';

describe('Gh spawn cwd', () => {
  it('resolves the working directory on every spawn, not once at construction', async () => {
    const seen: (string | undefined)[] = [];
    let root: string | undefined = '/repo/.wt/142';
    const run = async (_argv: readonly string[], init?: { cwd?: string }) => {
      seen.push(init?.cwd);
      return { exitCode: 0, stdout: 'HTTP/2.0 200 OK\nx: y\n\n{}', stderr: '' };
    };
    const cwd = async () => root;
    const gh = new Gh(run, cwd);
    const git = localGit(run, cwd);
    await gh.api('user');
    root = '/repo';
    await gh.api('user');
    await git(['tag']);
    expect(seen).toEqual(['/repo/.wt/142', '/repo', '/repo']);
  });

  it('spawns in the runner default when no resolver is given', async () => {
    const seen: (string | undefined)[] = [];
    const gh = new Gh(async (_argv, init) => {
      seen.push(init?.cwd);
      return { exitCode: 0, stdout: '{"nameWithOwner":"o/r","defaultBranch":"main"}', stderr: '' };
    });
    expect(await gh.repoInfo()).toEqual({ nameWithOwner: 'o/r', defaultBranch: 'main' });
    expect(seen).toEqual([undefined]);
  });
});
