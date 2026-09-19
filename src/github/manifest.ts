import type { Bump } from './commits.ts';

export type ManifestRule = { path: string; keys: string[]; bump: 'major' | 'minor' | 'patch' };

export type ManifestChange = { path: string; key: string; from: string | null; to: string | null; bump: Bump };

// flattens a toml document to dotted key -> raw value text. enough for manifests: tables, dotted keys, one value per line
export function flattenToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let table = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const t = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (t) {
      table = t[1]!.replace(/\s*\.\s*/g, '.').replace(/"/g, '');
      continue;
    }
    const kv = /^([A-Za-z0-9_."-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.replace(/"/g, '');
    out[table ? `${table}.${key}` : key] = kv[2]!.trim();
  }
  return out;
}

// the keys matching a rule that differ between two versions of the manifest
export function manifestChanges(rule: ManifestRule, before: string | undefined, after: string | undefined): ManifestChange[] {
  const a = before === undefined ? {} : flattenToml(before);
  const b = after === undefined ? {} : flattenToml(after);
  const patterns = rule.keys.map((k) => new RegExp(k));
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => patterns.some((p) => p.test(k)));
  return keys.filter((k) => a[k] !== b[k]).map((k) => ({ path: rule.path, key: k, from: a[k] ?? null, to: b[k] ?? null, bump: rule.bump }));
}
