import { truncate } from '../tokens.ts';
import type { Subject } from '../packs/types.ts';
import { pool } from '../pool.ts';

// where the index reads the checkout: tracked paths at the repo root, a file's size in bytes, its text
export type Tree = {
  list: () => Promise<string[]>;
  size: (path: string) => Promise<number | undefined>;
  read: (path: string) => Promise<string>;
};

export type IndexOptions = {
  // bytes, files above are skipped
  maxBytes: number;
  // non-empty lines of the excerpt and the width each is cut to
  excerptLines: number;
  excerptWidth: number;
  maxSymbols: number;
  // file names shown per directory
  sampleSize: number;
  // reads in flight at once
  concurrency: number;
};

export const INDEX_DEFAULTS: IndexOptions = { maxBytes: 200_000, excerptLines: 6, excerptWidth: 120, maxSymbols: 30, sampleSize: 8, concurrency: 16 };

export type FileEntry = { path: string; dir: string; excerpt: string; symbols: string[] };
export type DirEntry = { path: string; files: number; sample: string[] };

export type TreeIndex = { dirs: DirEntry[]; files: FileEntry[]; skipped: number };

const IGNORED_DIRS = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', 'target', '__pycache__', '.cache']);
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock', 'mix.lock', 'flake.lock', 'uv.lock']);
const BINARY = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'webp', 'avif', 'tif', 'tiff', 'psd', 'svgz',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mkv', 'mov', 'avi', 'webm',
  'wasm', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'obj', 'class', 'pyc', 'pyo', 'bin', 'dat', 'db', 'sqlite', 'sqlite3',
  'min.js', 'min.css', 'map',
]);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.indexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// what never enters the index: dependency and output trees, lockfiles, binaries by extension
export function ignored(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1]!;
  if (parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p))) return true;
  if (LOCKFILES.has(name)) return true;
  const ext = extensionOf(path);
  if (BINARY.has(ext)) return true;
  const last = ext.slice(ext.lastIndexOf('.') + 1);
  return BINARY.has(last);
}

export function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '.' : path.slice(0, at);
}

const MODIFIERS = '(?:(?:pub(?:\\([^)]*\\))?|export|default|public|private|protected|internal|static|async|abstract|final|open|sealed|unsafe|extern|inline|override|declare)\\s+)*';

// exported or top-level names by extension: one regex list per family, the generic keyword list for the rest
const GENERIC = [new RegExp(`^${MODIFIERS}(?:fn|fun|func|function|def|class|struct|str|enum|tag|trait|type|interface|module|mod|impl|proc|sub|object|record|union|protocol|extension|macro)\\s+([A-Za-z_$][\\w$]*)`)];
const SYMBOLS: { extensions: string[]; patterns: RegExp[] }[] = [
  {
    extensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
    patterns: [
      /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
      /^export\s*\{\s*([^}]*)\}/,
      /^module\.exports\.([A-Za-z_$][\w$]*)\s*=/,
      /^exports\.([A-Za-z_$][\w$]*)\s*=/,
    ],
  },
  { extensions: ['py', 'pyi'], patterns: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^class\s+([A-Za-z_]\w*)/] },
  { extensions: ['go'], patterns: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/] },
  { extensions: ['rs'], patterns: [/^\s*pub(?:\([^)]*\))?\s+(?:unsafe\s+)?(?:async\s+)?(?:extern\s+"[^"]*"\s+)?(?:fn|struct|enum|trait|type|mod|const|static|union)\s+([A-Za-z_]\w*)/] },
  {
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'm', 'mm'],
    patterns: [/^[A-Za-z_][\w\s*&<>:,]*?[\s*&]([A-Za-z_]\w*)\s*\([^;]*$/, /^(?:typedef\s+)?(?:struct|enum|union|class)\s+([A-Za-z_]\w*)/, /^#define\s+([A-Za-z_]\w*)/] },
  { extensions: ['rb'], patterns: [/^\s*(?:def|class|module)\s+(?:self\.)?([A-Za-z_][\w.?!]*)/] },
  { extensions: ['sh', 'bash', 'zsh', 'fish'], patterns: [/^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)/, /^function\s+([A-Za-z_][\w-]*)/] },
  { extensions: ['md', 'mdx', 'markdown', 'rst', 'txt'], patterns: [/^#{1,3}\s+(.+?)\s*#*\s*$/] },
  { extensions: ['java', 'kt', 'kts', 'scala', 'cs', 'swift', 'php', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml', 'zig', 'nim', 'lua', 'mach', 'jl', 'r', 'el', 'clj'], patterns: GENERIC },
];

const BY_EXTENSION = new Map<string, RegExp[]>();
for (const family of SYMBOLS) for (const ext of family.extensions) BY_EXTENSION.set(ext, family.patterns);

export function symbolsOf(path: string, text: string, max = INDEX_DEFAULTS.maxSymbols): string[] {
  const ext = extensionOf(path);
  const patterns = BY_EXTENSION.get(ext.slice(ext.lastIndexOf('.') + 1)) ?? GENERIC;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    for (const pattern of patterns) {
      const m = pattern.exec(line);
      if (!m) continue;
      // an export list names several, each maybe aliased
      const names = m[0].startsWith('export') && m[0].includes('{') ? m[1]!.split(',') : [m[1]!];
      for (const raw of names) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
        if (name && !seen.has(name)) {
          seen.add(name);
          out.push(name);
        }
      }
      break;
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

export function excerptOf(text: string, lines = INDEX_DEFAULTS.excerptLines, width = INDEX_DEFAULTS.excerptWidth): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    out.push(truncate(t, width));
    if (out.length >= lines) break;
  }
  return out.join('\n');
}

// every tracked file that is not ignored, binary or over the bound, and every directory holding one directly
export async function indexTree(tree: Tree, options: Partial<IndexOptions> = {}): Promise<TreeIndex> {
  const o = { ...INDEX_DEFAULTS, ...options };
  const paths = (await tree.list()).map((p) => p.trim()).filter(Boolean);
  const candidates = paths.filter((p) => !ignored(p));
  const read = await pool(candidates, o.concurrency, async (path): Promise<FileEntry | undefined> => {
    const size = await tree.size(path).catch(() => undefined);
    if (size === undefined || size > o.maxBytes) return undefined;
    const text = await tree.read(path).catch(() => undefined);
    if (text === undefined || text.includes('\0')) return undefined;
    return { path, dir: dirOf(path), excerpt: excerptOf(text, o.excerptLines, o.excerptWidth), symbols: symbolsOf(path, text, o.maxSymbols) };
  });
  const files = read.filter((f): f is FileEntry => f !== undefined);
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const names = byDir.get(f.dir) ?? [];
    names.push(f.path.slice(f.path.lastIndexOf('/') + 1));
    byDir.set(f.dir, names);
  }
  const dirs = [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, names]) => ({ path, files: names.length, sample: names.slice(0, o.sampleSize) }));
  return { dirs, files, skipped: paths.length - files.length };
}

const TEXT_CAP = 20_000;

// the tree subject: the text is the state every rank reads against, the index is the facts the steps rank
export function treeSubject(text: string, ref: string, index: TreeIndex): Subject {
  return {
    kind: 'tree',
    ref,
    state: { text: truncate(text, TEXT_CAP) },
    facts: { dirs: index.dirs, files: index.files, total_files: index.files.length, skipped_files: index.skipped, has_files: index.files.length > 0 },
    options: {},
  };
}
