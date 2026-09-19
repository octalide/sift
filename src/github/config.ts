export type RepoConfig = {
  commits: {
    convention: 'conventional' | 'none';
    types: string[];
    // issue: scope must be #<n>; any: free scope; none: no scope allowed
    scope: 'issue' | 'any' | 'none';
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
    target?: string;
    templateSections: string[];
  };
  rules: {
    docs: string[];
  };
  release: {
    // unset: no version is computed or checked
    scheme?: 'semver';
    // unset: no changelog is read or checked
    changelog?: string;
    tagPrefix: string;
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
  rules: { docs: ['CONTRIBUTING.md', 'CLAUDE.md', 'AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md'] },
  release: { tagPrefix: 'v' },
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

// layers apply in order, each field by field over the last
export function resolveConfig(layers: unknown | unknown[], defaultBranch?: string): RepoConfig {
  let config = DEFAULT_CONFIG;
  for (const raw of Array.isArray(layers) ? layers : [layers]) {
    if (raw && typeof raw === 'object') config = merge(config, raw as Partial<RepoConfig>);
  }
  if (config.branches.protected.length === 0 && defaultBranch) {
    config.branches = { ...config.branches, protected: [defaultBranch] };
  }
  return config;
}
