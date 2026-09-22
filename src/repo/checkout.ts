import type { Forge } from '../forge/forge.ts';
import { localGit, type Git } from '../forge/git.ts';
import { loadPacks, type FsLike } from '../packs/load.ts';
import type { Pack } from '../packs/types.ts';
import type { RunLike } from '../process.ts';
import { CONFIG_PATH, PACKS_DIR, resolveConfig, type RepoConfig } from './config.ts';

export type CheckoutFs = FsLike & { stat: (path: string) => Promise<{ size: number; mtimeMs?: number }> };

// one directory's repository: where it is, what it is on the forge, and the conventions and packs it defines
export type Checkout = {
  // the git toplevel of the directory (the worktree itself, not its main tree), or the directory when it is not in git
  root: string;
  // git in root; undefined when the directory is not in a git checkout
  git?: Git;
  // the forge repository root is a checkout of, when it has a remote on the forge
  repo?: string;
  defaultBranch?: string;
  config: RepoConfig;
  packs: Record<string, Pack>;
};

export type CheckoutHost = {
  run: RunLike;
  fs: CheckoutFs;
  // a forge whose checkout() answers for the directory
  forgeAt: (dir: string) => Forge;
  // the config layer under every repository's own file: the config option, or else the global file
  base: () => unknown;
};

type Entry = { repo?: string; defaultBranch?: string; stamp: string; config: RepoConfig; packs: Record<string, Pack> };

// resolves a directory to its checkout, caching the forge lookup by root and the conventions until .sift/ changes
export class Checkouts {
  private readonly cache = new Map<string, Entry>();

  constructor(private readonly host: CheckoutHost) {}

  async resolve(dir: string): Promise<Checkout> {
    if (!dir.startsWith('/')) throw new Error(`cwd must be an absolute path, got ${dir}`);
    if (!(await this.host.fs.exists(dir))) throw new Error(`cwd ${dir} does not exist`);
    const top = await this.host.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 30_000 });
    const inGit = top.exitCode === 0 && top.stdout.trim() !== '';
    const root = inGit ? top.stdout.trim() : dir;
    const git = inGit ? localGit(this.host.run, async () => root) : undefined;
    const stamp = await this.stamp(root);
    let entry = this.cache.get(root);
    if (!entry) {
      const found = await this.host.forgeAt(root).checkout();
      entry = { repo: found?.repo, defaultBranch: found?.defaultBranch, ...(await this.conventions(root, found?.defaultBranch)), stamp };
    } else if (entry.stamp !== stamp) {
      entry = { ...entry, ...(await this.conventions(root, entry.defaultBranch)), stamp };
    }
    this.cache.set(root, entry);
    return { root, git, repo: entry.repo, defaultBranch: entry.defaultBranch, config: entry.config, packs: entry.packs };
  }

  // a repository's conventions read through the forge, for a subject in a repository no checkout here serves
  async remoteConfig(forge: Forge, repo: string): Promise<RepoConfig> {
    const defaultBranch = await forge.defaultBranch(repo);
    const raw = await forge.file(repo, CONFIG_PATH, defaultBranch);
    return resolveConfig([this.host.base(), raw === undefined ? undefined : parseJson(raw, `${repo}:${CONFIG_PATH}`)], defaultBranch);
  }

  private async conventions(root: string, defaultBranch: string | undefined): Promise<Pick<Entry, 'config' | 'packs'>> {
    const path = `${root}/${CONFIG_PATH}`;
    const own = (await this.host.fs.exists(path)) ? parseJson(await this.host.fs.read(path), path) : undefined;
    return { config: resolveConfig([this.host.base(), own], defaultBranch), packs: await loadPacks(this.host.fs, root) };
  }

  // what the conventions were read from: the config file and every pack file, by modification time
  private async stamp(root: string): Promise<string> {
    const { fs } = this.host;
    const mtime = async (p: string) => ((await fs.exists(p)) ? String((await fs.stat(p)).mtimeMs ?? '') : '-');
    const parts = [await mtime(`${root}/${CONFIG_PATH}`)];
    const dir = `${root}/${PACKS_DIR}`;
    if (await fs.exists(dir)) {
      for (const e of await fs.list(dir)) parts.push(`${e.name}:${await mtime(`${dir}/${e.name}`)}`);
    }
    return parts.join('|');
  }
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
