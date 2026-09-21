import type { Bump } from './commits.ts';

export type ManifestRule = { path: string; keys?: string[]; pattern?: string; bump: 'major' | 'minor' | 'patch' };

export type ManifestChange = { path: string; key: string; from: string | null; to: string | null; bump: Bump };

export type ManifestFormat = 'toml' | 'json' | 'yaml';

export function manifestFormat(path: string): ManifestFormat | undefined {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  if (ext === 'toml') return 'toml';
  if (ext === 'json') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  return undefined;
}

export function parseManifest(format: ManifestFormat, text: string): unknown {
  if (format === 'json') return JSON.parse(text);
  if (format === 'toml') return parseToml(text);
  return parseYaml(text);
}

// dotted path -> value text, arrays indexed numerically. an empty array or table is a leaf so its first member shows as a change
export function flattenManifest(value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (Array.isArray(value) && value.length > 0) {
    value.forEach((v, i) => flattenManifest(v, prefix ? `${prefix}.${i}` : String(i), out));
  } else if (isTable(value) && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) flattenManifest(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = show(value);
  }
  return out;
}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[]';
  if (isTable(value)) return '{}';
  return String(value);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// the text a rule's pattern matches, every match joined, or null when the file is absent
function matched(pattern: RegExp, text: string | undefined): string | null {
  if (text === undefined) return null;
  return [...text.matchAll(pattern)].map((m) => m[0]).join('\n');
}

// the keys and pattern matches of a rule that differ between two versions of the manifest
export function manifestChanges(rule: ManifestRule, before: string | undefined, after: string | undefined): ManifestChange[] {
  const out: ManifestChange[] = [];
  const format = manifestFormat(rule.path);
  const keys = rule.keys ?? [];
  if (format && keys.length > 0) {
    const a = before === undefined ? {} : flattenManifest(parseManifest(format, before));
    const b = after === undefined ? {} : flattenManifest(parseManifest(format, after));
    const patterns = keys.map((k) => new RegExp(k));
    const all = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => patterns.some((p) => p.test(k)));
    out.push(...all.filter((k) => a[k] !== b[k]).map((k) => ({ path: rule.path, key: k, from: a[k] ?? null, to: b[k] ?? null, bump: rule.bump })));
  }
  if (rule.pattern) {
    const re = new RegExp(rule.pattern, 'gm');
    const from = matched(re, before);
    const to = matched(re, after);
    if (from !== to) out.push({ path: rule.path, key: `/${rule.pattern}/`, from, to, bump: rule.bump });
  }
  return out;
}

// toml: tables, arrays of tables, dotted and quoted keys, strings, numbers, booleans, arrays and inline tables.
// dates and anything else unparsed stay as their text
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table = root;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = stripTomlComment(lines[i]!).trim();
    if (line === '') continue;
    const header = /^(\[\[?)\s*(.+?)\s*\]\]?$/.exec(line);
    if (header) {
      table = openTable(root, parseKeyPath(header[2]!), header[1] === '[[');
      continue;
    }
    const eq = indexOutsideStrings(line, '=');
    if (eq < 0) continue;
    const path = parseKeyPath(line.slice(0, eq).trim());
    let raw = line.slice(eq + 1).trim();
    while (i + 1 < lines.length && tomlValueOpen(raw)) raw += `\n${stripTomlComment(lines[++i]!)}`;
    const target = walk(table, path.slice(0, -1));
    target[path[path.length - 1]!] = parseTomlValue(raw.trim());
  }
  return root;
}

function stripTomlComment(line: string): string {
  const at = indexOutsideStrings(line, '#');
  return at < 0 ? line : line.slice(0, at);
}

// the first position of ch that is not inside a quoted string
function indexOutsideStrings(line: string, ch: string): number {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ch) return i;
  }
  return -1;
}

// a value continues on the next line while a bracket or a triple-quoted string is open
function tomlValueOpen(raw: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === '\\' && quote[0] === '"') i++;
      else if (raw.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = undefined;
      }
    } else if (raw.startsWith('"""', i) || raw.startsWith("'''", i)) {
      quote = raw.slice(i, i + 3);
      i += 2;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth > 0 || quote !== undefined;
}

function parseKeyPath(key: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const c of key) {
    if (quote) {
      if (c === quote) quote = undefined;
      else current += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '.') {
      parts.push(current.trim());
      current = '';
    } else current += c;
  }
  parts.push(current.trim());
  return parts;
}

// the table at a path, made on the way; an array member is its last element
function walk(from: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let at = from;
  for (const k of path) {
    let next = at[k];
    if (Array.isArray(next)) next = next[next.length - 1];
    if (isTable(next)) {
      at = next;
    } else {
      const made: Record<string, unknown> = {};
      at[k] = made;
      at = made;
    }
  }
  return at;
}

function openTable(root: Record<string, unknown>, path: string[], arrayOf: boolean): Record<string, unknown> {
  if (!arrayOf) return walk(root, path);
  const parent = walk(root, path.slice(0, -1));
  const name = path[path.length - 1]!;
  const list = Array.isArray(parent[name]) ? (parent[name] as unknown[]) : [];
  parent[name] = list;
  const table: Record<string, unknown> = {};
  list.push(table);
  return table;
}

function parseTomlValue(raw: string): unknown {
  const r = new Cursor(raw);
  const v = r.value();
  return r.done() ? v : raw;
}

// recursive descent over one toml value
class Cursor {
  private i = 0;
  constructor(private readonly s: string) {}

  done(): boolean {
    this.ws();
    return this.i >= this.s.length;
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  value(): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.array();
    if (c === '{') return this.inlineTable();
    if (this.s.startsWith('"""', this.i)) return this.multiline('"""');
    if (this.s.startsWith("'''", this.i)) return this.multiline("'''");
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    const start = this.i;
    while (this.i < this.s.length && !/[,\]}\s]/.test(this.s[this.i]!)) this.i++;
    const word = this.s.slice(start, this.i);
    if (word === 'true') return true;
    if (word === 'false') return false;
    const n = /^[+-]?(0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+|(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?|inf|nan)$/i.test(word) ? Number(word.replace(/_/g, '')) : NaN;
    return Number.isNaN(n) ? word : n;
  }

  private array(): unknown[] {
    const out: unknown[] = [];
    this.i++;
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      if (this.i >= this.s.length) return out;
      out.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') this.i++;
    }
  }

  private inlineTable(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.i++;
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      if (this.i >= this.s.length) return out;
      const eq = this.s.indexOf('=', this.i);
      if (eq < 0) return out;
      const path = parseKeyPath(this.s.slice(this.i, eq).trim());
      this.i = eq + 1;
      walk(out, path.slice(0, -1))[path[path.length - 1]!] = this.value();
      this.ws();
      if (this.s[this.i] === ',') this.i++;
    }
  }

  private basicString(): string {
    let out = '';
    this.i++;
    while (this.i < this.s.length && this.s[this.i] !== '"') {
      if (this.s[this.i] === '\\') {
        this.i++;
        out += unescape(this.s[this.i]!);
      } else out += this.s[this.i];
      this.i++;
    }
    this.i++;
    return out;
  }

  private literalString(): string {
    const end = this.s.indexOf("'", this.i + 1);
    const out = this.s.slice(this.i + 1, end < 0 ? undefined : end);
    this.i = end < 0 ? this.s.length : end + 1;
    return out;
  }

  private multiline(quote: string): string {
    const end = this.s.indexOf(quote, this.i + 3);
    const out = this.s.slice(this.i + 3, end < 0 ? undefined : end).replace(/^\n/, '');
    this.i = end < 0 ? this.s.length : end + 3;
    return out;
  }
}

function unescape(c: string): string {
  return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' }[c] ?? c;
}

// yaml: block mappings and sequences, plain and quoted scalars, flow collections, literal and folded block scalars
export function parseYaml(text: string): unknown {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => !/^(---|\.\.\.)\s*$/.test(l))
    .map((l) => stripYamlComment(l))
    .map((l) => (l.trim() === '' ? '' : l.replace(/\s+$/, '')));
  const doc = new Yaml(lines);
  return doc.block(doc.next(0) ?? lines.length, -1);
}

function stripYamlComment(line: string): string {
  if (/^\s*#/.test(line)) return '';
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s:\-,[{]/.test(line[i - 1]!))) quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

class Yaml {
  constructor(private readonly lines: string[]) {}

  // the next non-blank line at or after i
  next(i: number): number | undefined {
    while (i < this.lines.length && this.lines[i] === '') i++;
    return i < this.lines.length ? i : undefined;
  }

  private indentOf(i: number): number {
    return this.lines[i]!.length - this.lines[i]!.trimStart().length;
  }

  // the block starting at line i, which must be deeper than parent
  block(i: number, parent: number): unknown {
    if (i >= this.lines.length || this.indentOf(i) <= parent) return null;
    const indent = this.indentOf(i);
    const body = this.lines[i]!.trim();
    if (body === '-' || body.startsWith('- ')) return this.sequence(i, indent);
    if (mappingKey(body)) return this.mapping(i, indent);
    return this.plainScalar(i, indent).value;
  }

  private sequence(i: number, indent: number): unknown[] {
    const out: unknown[] = [];
    let at: number | undefined = i;
    while (at !== undefined && this.indentOf(at) === indent && /^-(\s|$)/.test(this.lines[at]!.trim())) {
      const rest = this.lines[at]!.trim().slice(1).trim();
      if (rest === '') {
        out.push(this.block(this.next(at + 1) ?? this.lines.length, indent));
      } else {
        // the item's own text is the first line of a block nested one level in
        this.lines[at] = `${' '.repeat(indent + 2)}${rest}`;
        out.push(this.block(at, indent));
      }
      at = this.skipDeeper(at + 1, indent);
    }
    return out;
  }

  private mapping(i: number, indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let at: number | undefined = i;
    while (at !== undefined && this.indentOf(at) === indent) {
      const body = this.lines[at]!.trim();
      const key = mappingKey(body);
      if (!key) break;
      const rest = body.slice(key.length).trim();
      if (rest === '') {
        out[key.name] = this.block(this.next(at + 1) ?? this.lines.length, indent);
      } else if (/^[|>][+-]?$/.test(rest)) {
        out[key.name] = this.blockScalar(at + 1, indent, rest);
      } else {
        this.lines[at] = `${' '.repeat(indent + 2)}${rest}`;
        out[key.name] = this.plainScalar(at, indent + 2).value;
      }
      at = this.skipDeeper(at + 1, indent);
    }
    return out;
  }

  // the first line at an indent no deeper than this level, or undefined at the end
  private skipDeeper(i: number, indent: number): number | undefined {
    let at = this.next(i);
    while (at !== undefined && this.indentOf(at) > indent) at = this.next(at + 1);
    return at;
  }

  private blockScalar(i: number, indent: number, style: string): string {
    const parts: string[] = [];
    let at = i;
    while (at < this.lines.length && (this.lines[at] === '' || this.indentOf(at) > indent)) parts.push(this.lines[at++]!);
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    const depth = Math.min(...parts.filter((p) => p !== '').map((p) => p.length - p.trimStart().length));
    const text = parts.map((p) => p.slice(depth)).join(style[0] === '|' ? '\n' : ' ');
    return style.endsWith('-') ? text : `${text}\n`;
  }

  // a scalar or flow value on one line, continued on deeper lines when plain
  private plainScalar(i: number, indent: number): { value: unknown } {
    let raw = this.lines[i]!.trim();
    let at = this.next(i + 1);
    while (at !== undefined && this.indentOf(at) >= indent && !/^["'[{]/.test(raw)) {
      raw += ` ${this.lines[at]!.trim()}`;
      at = this.next(at + 1);
    }
    return { value: scalar(raw) };
  }
}

// the key at the head of a mapping line, with the text it spans
function mappingKey(body: string): { name: string; length: number } | undefined {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'):(\s|$)/.exec(body);
  if (quoted) return { name: String(scalar(quoted[1]!)), length: quoted[1]!.length + 1 };
  const plain = /^([^\s"'#\-[\]{},][^:#]*?):(\s|$)/.exec(body);
  if (plain) return { name: plain[1]!.trim(), length: plain[1]!.length + 1 };
  return undefined;
}

function scalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'")) return s.slice(1, s.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
  if (s.startsWith('[') || s.startsWith('{')) return flow(s);
  if (/^[+-]?(\d[\d_]*(\.\d*)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+)$/.test(s)) return Number(s.replace(/_/g, ''));
  return s;
}

// a flow collection: [a, b] or {k: v}, nested or quoted members split on top-level commas
function flow(s: string): unknown {
  const inner = s.slice(1, s.endsWith(s[0] === '[' ? ']' : '}') ? -1 : undefined);
  const items = splitTop(inner).filter((x) => x.trim() !== '');
  if (s[0] === '[') return items.map((x) => scalar(x));
  const out: Record<string, unknown> = {};
  for (const item of items) {
    const key = mappingKey(item.trim()) ?? { name: item.trim(), length: item.trim().length };
    out[key.name] = scalar(item.trim().slice(key.length));
  }
  return out;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}
