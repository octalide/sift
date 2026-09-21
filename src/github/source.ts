import { LOG_FORMAT, splitLog, type RawCommit } from './commits.ts';
import type { Gh } from './gh.ts';

// where a release reads its history from: the checkout when the session has one, GitHub otherwise
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
export function localSource(gh: Gh, head: string, read: ReadLike, exists: ExistsLike): GitSource {
  return {
    head,
    tags: async () => (await gh.git(['tag', '--list']).catch(() => '')).split('\n').map((t) => t.trim()).filter(Boolean),
    log: async (base) => splitLog(await gh.git(['log', LOG_FORMAT, '--no-merges', base ? `${base}..${head}` : head])),
    show: async (ref, path) => {
      if (ref === 'HEAD' && (await exists(path))) return read(path);
      return gh.git(['show', `${ref}:${path}`]).catch(() => undefined);
    },
  };
}

type Compare = { commits: { sha: string; parents: { sha: string }[]; commit: { message: string } }[] };

export function remoteSource(gh: Gh, repo: string, head: string): GitSource {
  const commit = (c: Compare['commits'][number]): RawCommit => ({ sha: c.sha, message: c.commit.message });
  return {
    head,
    tags: async () => (await gh.pages<string>(`repos/${repo}/tags`, '[.[].name]')).flat(),
    log: async (base) => {
      if (!base) {
        const all = await gh.pages<{ sha: string; parents: { sha: string }[]; commit: { message: string } }>(
          `repos/${repo}/commits?sha=${encodeURIComponent(head)}`,
          '[.[] | {sha, parents, commit: {message: .commit.message}}]',
        );
        return all.filter((c) => c.parents.length < 2).map(commit);
      }
      // compare lists oldest first and caps at 250; the release ranges here are far smaller
      const cmp = await gh.json<Compare>(`repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      return cmp.commits
        .filter((c) => c.parents.length < 2)
        .map(commit)
        .reverse();
    },
    show: (ref, path) => gh.text(`repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, 'application/vnd.github.raw+json').catch(() => undefined),
  };
}
