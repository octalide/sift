import { BUMPS, CONVENTIONAL_BUMPS, CONVENTIONAL_FORMAT, type Bump } from './commits.ts';
import { CALVER_PATTERN, SEMVER_PATTERN } from './version.ts';
import type { Channel } from '../gate/channels.ts';
import { isTextKind, TEXT_KIND_NAMES } from '../rules/kinds.ts';

// presets expand to a regex at resolve time; an explicit pattern beside one wins
export const COMMIT_FORMATS = { conventional: CONVENTIONAL_FORMAT } as const;
export const COMMIT_BUMPS: Record<keyof typeof COMMIT_FORMATS, Record<string, Bump>> = { conventional: CONVENTIONAL_BUMPS };
// matched against type(scope), or the bare type without a scope
export const SCOPE_PATTERNS = { issue: String.raw`^(chore\(.*\)|[^(]+(\(#\d+\))?)$`, none: String.raw`^[^(]*$` } as const;
export const VERSION_PATTERNS = { semver: SEMVER_PATTERN, calver: CALVER_PATTERN } as const;

export type RepoConfig = {
  commits: {
    // preset for format: conventional is the conventional commits header, none runs no format check
    convention: keyof typeof COMMIT_FORMATS | 'none';
    // regex over the subject line with the named groups type, scope, breaking and description
    format?: string;
    types: string[];
    // the release bump each type calls for; a type not listed calls for none, and a breaking change is a breaking
    // bump whatever its type. unset, the convention's preset fills it (conventional: feat minor, fix and perf patch)
    bumps?: Record<string, Bump>;
    // preset for scopePattern: issue requires #<n> (chore excepted), any accepts anything, none forbids a scope
    scope: keyof typeof SCOPE_PATTERNS | 'any';
    // regex over the header's type(scope), or the bare type when there is no scope
    scopePattern?: string;
    forbidTrailers: string[];
  };
  branches: {
    protected: string[];
    // regex for work branches, e.g. ^(feat|fix|chore)/\d+$
    pattern?: string;
  };
  issues: {
    // each inner list is a group, one label from each group is required
    requiredLabelGroups: string[][];
    milestone: boolean;
    templateSections: string[];
    // labels whose issues must be a sub-issue of a parent
    childLabels: string[];
  };
  prs: {
    linkIssue: boolean;
    // branches a PR may target, as a list of names or a regex; target: "dev" from older configs reads as targets: ["dev"]
    targets?: string[] | string;
    templateSections: string[];
  };
  rules: {
    // documents used without being judged as rule documents: paths in the checkout, or owner/repo:path[@ref] read from the forge
    docs: string[];
    // paths or globs (* within a segment, ** across) never considered as rule documents
    exclude: string[];
    // rules past this count are dropped and rules.present says so
    maxRules: number;
  };
  release: {
    // preset for versionPattern; with neither set no version is computed or checked
    scheme?: keyof typeof VERSION_PATTERNS;
    // regex over a version: its numeric named groups order it, major, minor and patch (when named) bump it
    versionPattern?: string;
    // regex over a tag with a version group; by default tagPrefix followed by the version
    tagPattern?: string;
    // unset: no changelog is read or checked
    changelog?: string;
    tagPrefix: string;
    // what a breaking change requires below 1.0.0
    zeroVerBreaking: 'major' | 'minor';
    // manifests whose changes require a bump on their own: keys are regexes over dotted paths in a toml, json or yaml
    // file (arrays indexed numerically), pattern a regex over the text of any file whose matched text must not change
    manifests: { path: string; keys?: string[]; pattern?: string; bump: 'major' | 'minor' | 'patch' }[];
  };
  outbound: {
    // channels added to the default table, or replacing a default entry of the same name
    channels: Channel[];
  };
};

export const DEFAULT_CONFIG: RepoConfig = {
  commits: {
    convention: 'none',
    types: ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'style', 'ci', 'perf', 'build', 'revert'],
    scope: 'any',
    forbidTrailers: [],
  },
  branches: { protected: [] },
  issues: { requiredLabelGroups: [], milestone: false, templateSections: [], childLabels: [] },
  prs: { linkIssue: false, templateSections: [] },
  rules: { docs: [], exclude: [], maxRules: 200 },
  release: { tagPrefix: 'v', zeroVerBreaking: 'minor', manifests: [] },
  outbound: { channels: [] },
};

export const CONFIG_PATH = '.sift/config.json';
export const PACKS_DIR = '.sift/packs';

function merge<T extends Record<string, unknown>>(base: T, over: Partial<T> | undefined): T {
  if (!over) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const current = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && current && typeof current === 'object' && !Array.isArray(current)) {
      out[k] = merge(current as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

// layers apply in order, each field by field over the last; presets expand once the layers are merged
export function resolveConfig(layers: unknown | unknown[], defaultBranch?: string): RepoConfig {
  let config = DEFAULT_CONFIG;
  for (const raw of Array.isArray(layers) ? layers : [layers]) {
    if (raw && typeof raw === 'object') config = merge(config, raw as Partial<RepoConfig>);
  }
  if (config.branches.protected.length === 0 && defaultBranch) {
    config.branches = { ...config.branches, protected: [defaultBranch] };
  }
  return expandPresets(config);
}

function expandPresets(config: RepoConfig): RepoConfig {
  const commits = { ...config.commits };
  // commits parse with the conventional header when no format is set at all, so the bumps follow the same fallback
  if (commits.bumps === undefined) commits.bumps = commits.convention !== 'none' ? COMMIT_BUMPS[commits.convention] : commits.format === undefined ? CONVENTIONAL_BUMPS : {};
  for (const [type, bump] of Object.entries(commits.bumps)) {
    if (!BUMPS.includes(bump)) throw new Error(`sift config: commits.bumps.${type} is ${JSON.stringify(bump)}, not one of ${BUMPS.join(', ')}`);
  }
  if (commits.format === undefined && commits.convention !== 'none') commits.format = COMMIT_FORMATS[commits.convention];
  if (commits.scopePattern === undefined && commits.scope !== 'any') commits.scopePattern = SCOPE_PATTERNS[commits.scope];
  const { target, ...prs } = config.prs as RepoConfig['prs'] & { target?: string };
  if (prs.targets === undefined && target !== undefined) prs.targets = [target];
  const release = { ...config.release };
  if (release.versionPattern === undefined && release.scheme !== undefined) release.versionPattern = VERSION_PATTERNS[release.scheme];
  if (release.tagPattern === undefined) release.tagPattern = tagPatternFor(release.tagPrefix);
  return { ...config, commits, prs, release };
}

// a config file's text, parsed with every regex field in it compiled, so a bad one is refused where the file is read
// rather than by the first grade that reaches it. from names the file in the error
export function readConfig(text: string, from: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`sift config ${from}: ${(e as Error).message}`);
  }
  for (const [field, pattern] of patternFields(raw)) {
    try {
      new RegExp(pattern);
    } catch (e) {
      throw new Error(`sift config ${from}: ${field} is not a valid regex: ${(e as Error).message}`);
    }
  }
  listOf(fieldsOf(fieldsOf(raw).outbound).channels).forEach((c, i) => {
    const channel = fieldsOf(c);
    if (channel.textKind !== undefined && !isTextKind(channel.textKind)) {
      throw new Error(`sift config ${from}: outbound.channels[${entry(channel.name, i)}].textKind is ${JSON.stringify(channel.textKind)}, not one of ${TEXT_KIND_NAMES.join(', ')}`);
    }
  });
  return raw;
}

const fieldsOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
// an entry of a list by its name when it has one, else by its index
const entry = (name: unknown, i: number) => (typeof name === 'string' && name !== '' ? name : String(i));

// every field of one layer that holds a regex, by its dotted name, where the layer sets it to a string
function patternFields(raw: unknown): [string, string][] {
  const layer = fieldsOf(raw);
  const commits = fieldsOf(layer.commits);
  const branches = fieldsOf(layer.branches);
  const prs = fieldsOf(layer.prs);
  const release = fieldsOf(layer.release);
  const outbound = fieldsOf(layer.outbound);
  const fields: [string, unknown][] = [
    ['commits.format', commits.format],
    ['commits.scopePattern', commits.scopePattern],
    ['branches.pattern', branches.pattern],
    ['prs.targets', prs.targets],
    ['release.versionPattern', release.versionPattern],
    ['release.tagPattern', release.tagPattern],
    ...listOf(release.manifests).flatMap((m, i): [string, unknown][] => {
      const manifest = fieldsOf(m);
      const at = `release.manifests[${entry(manifest.path, i)}]`;
      return [...listOf(manifest.keys).map((k, j): [string, unknown] => [`${at}.keys[${j}]`, k]), [`${at}.pattern`, manifest.pattern]];
    }),
    ...listOf(outbound.channels).flatMap((c, i): [string, unknown][] => {
      const channel = fieldsOf(c);
      const at = `outbound.channels[${entry(channel.name, i)}]`;
      return [[`${at}.tool`, channel.tool], [`${at}.text.command`, fieldsOf(channel.text).command]];
    }),
  ];
  return fields.filter((f): f is [string, string] => typeof f[1] === 'string');
}

// the tag pattern a prefix stands for: the prefix, then the version
export function tagPatternFor(prefix: string): string {
  return `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?<version>.+)$`;
}

// the branch a release is cut from when none is named: the first listed target, none when targets is a regex
export function defaultTarget(config: RepoConfig): string | undefined {
  return Array.isArray(config.prs.targets) ? config.prs.targets[0] : undefined;
}

// the global file: $XDG_CONFIG_HOME/sift/config.json, else ~/.config/sift/config.json
export function globalConfigPath(env: { XDG_CONFIG_HOME?: string | null; HOME?: string | null }): string | undefined {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? `${env.HOME}/.config` : undefined);
  return base ? `${base}/sift/config.json` : undefined;
}

export type ConfigSources = {
  // the config option, parsed; set, it replaces the global file
  option?: unknown;
  // the global file, parsed, when it exists
  global?: unknown;
  // the repository's .sift/config.json, parsed, when it exists
  repo?: unknown;
};

// layers in application order: defaults, then the option or the global file, then the repository file
export function configLayers(sources: ConfigSources): unknown[] {
  return [sources.option !== undefined ? sources.option : sources.global, sources.repo];
}
