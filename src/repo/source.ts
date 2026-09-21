import type { Forge } from '../forge/forge.ts';
import type { Git } from '../forge/git.ts';
import { LOG_FORMAT, splitLog, type RawCommit } from './commits.ts';

// where a release reads its history from: the checkout when the session has one, the forge otherwise
export type GitSource = {
  // the ref the release is cut from, as the caller names it
  head: string;
  tags: () => Promise<string[]>;
  // non-merge commits reachable from head and not from base, unparsed; base undefined means all of history
  log: (base: string | undefined) => Promise<RawCommit[]>;
  // a file at a ref, undefined when absent
  show: (ref: string, path: string) => Promise<string | undefined>;
};

export type ReadLike = (path: string) => Promise<string>;
export type ExistsLike = (path: string) => Promise<boolean>;

// the working tree stands in for HEAD so an uncommitted changelog promotion is graded before it is committed
export function localSource(git: Git, head: string, read: ReadLike, exists: ExistsLike): GitSource {
  return {
    head,
    tags: async () => (await git(['tag', '--list']).catch(() => '')).split('\n').map((t) => t.trim()).filter(Boolean),
    log: async (base) => splitLog(await git(['log', LOG_FORMAT, '--no-merges', base ? `${base}..${head}` : head])),
    show: async (ref, path) => {
      if (ref === 'HEAD' && (await exists(path))) return read(path);
      return git(['show', `${ref}:${path}`]).catch(() => undefined);
    },
  };
}

export function remoteSource(forge: Forge, repo: string, head: string): GitSource {
  return {
    head,
    tags: () => forge.tags(repo),
    log: async (base) => (await (base ? forge.compare(repo, base, head) : forge.commits(repo, head))).filter((c) => !c.merge).map((c) => ({ sha: c.sha, message: c.message })),
    show: (ref, path) => forge.file(repo, path, ref),
  };
}
