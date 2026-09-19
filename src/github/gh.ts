export type RunLike = (
  argv: readonly string[],
  init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type ApiResponse = {
  status: number;
  etag?: string;
  remaining?: number;
  reset?: number;
  body: string;
};

export class GhError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

// gh api over a process runner; conditional requests answer 304 with an empty body
export class Gh {
  constructor(
    private readonly run: RunLike,
    private readonly cwd?: string,
  ) {}

  async api(path: string, opts: { etag?: string; accept?: string; paginate?: boolean; method?: string; fields?: Record<string, string> } = {}): Promise<ApiResponse> {
    const argv = ['gh', 'api', '-i'];
    if (opts.method) argv.push('-X', opts.method);
    if (opts.paginate) argv.push('--paginate');
    if (opts.etag) argv.push('-H', `If-None-Match: ${opts.etag}`);
    if (opts.accept) argv.push('-H', `Accept: ${opts.accept}`);
    for (const [k, v] of Object.entries(opts.fields ?? {})) argv.push('-f', `${k}=${v}`);
    argv.push(path);
    const result = await this.run(argv, { cwd: this.cwd, timeoutMs: 60_000 });
    const parsed = splitResponse(result.stdout);
    if (parsed.status === 0) {
      throw new GhError(result.stderr.trim() || `gh api ${path} produced no response`, result.exitCode);
    }
    if (parsed.status >= 400) {
      throw new GhError(`gh api ${path}: http ${parsed.status} ${parsed.body.slice(0, 200)}`, result.exitCode);
    }
    return parsed;
  }

  async json<T>(path: string, opts: Parameters<Gh['api']>[1] = {}): Promise<T> {
    const response = await this.api(path, opts);
    return JSON.parse(response.body || 'null') as T;
  }

  // pages through a list endpoint one request at a time, each slimmed by jq so no page nears the output limit
  async pages<T>(path: string, jq: string, perPage = 100, maxPages = 200): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
      const argv = ['gh', 'api', '--jq', jq, `${path}${sep}per_page=${perPage}&page=${page}`];
      const result = await this.run(argv, { cwd: this.cwd, timeoutMs: 60_000 });
      if (result.exitCode !== 0) throw new GhError(`gh api ${path} page ${page}: ${result.stderr.trim()}`, result.exitCode);
      const items = JSON.parse(result.stdout.trim() || '[]') as T[];
      out.push(...items);
      if (items.length < perPage) break;
    }
    return out;
  }

  async text(path: string, accept: string): Promise<string> {
    return (await this.api(path, { accept })).body;
  }

  async git(args: string[]): Promise<string> {
    const result = await this.run(['git', ...args], { cwd: this.cwd, timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new GhError(`git ${args.join(' ')}: ${result.stderr.trim()}`, result.exitCode);
    return result.stdout;
  }

  async login(): Promise<string | undefined> {
    try {
      const me = await this.json<{ login?: string }>('user');
      return me.login;
    } catch {
      return undefined;
    }
  }

  async repoInfo(): Promise<{ nameWithOwner: string; defaultBranch: string } | undefined> {
    const result = await this.run(
      ['gh', 'repo', 'view', '--json', 'nameWithOwner,defaultBranchRef', '--jq', '{nameWithOwner, defaultBranch: .defaultBranchRef.name}'],
      { cwd: this.cwd, timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) return undefined;
    try {
      return JSON.parse(result.stdout) as { nameWithOwner: string; defaultBranch: string };
    } catch {
      return undefined;
    }
  }
}

// gh api -i prints headers, a blank line, then the body; --paginate repeats that per page
export function splitResponse(raw: string): ApiResponse {
  const pages: { headers: Record<string, string>; status: number; body: string }[] = [];
  let rest = raw.replace(/\r\n/g, '\n');
  while (rest.length > 0) {
    const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(rest);
    if (!m) break;
    const status = Number(m[1]);
    const headerEnd = rest.indexOf('\n\n', m[0].length);
    const headerText = headerEnd < 0 ? rest.slice(m[0].length) : rest.slice(m[0].length, headerEnd);
    const headers: Record<string, string> = {};
    for (const line of headerText.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    let body = headerEnd < 0 ? '' : rest.slice(headerEnd + 2);
    const nextPage = body.search(/\nHTTP\/[\d.]+ \d{3}/);
    if (nextPage >= 0) {
      rest = body.slice(nextPage + 1);
      body = body.slice(0, nextPage);
    } else {
      rest = '';
    }
    pages.push({ headers, status, body: body.trim() });
  }
  if (pages.length === 0) return { status: 0, body: '' };
  const last = pages[pages.length - 1]!;
  const merged =
    pages.length === 1
      ? last.body
      : `[${pages
          .map((p) => p.body.trim())
          .filter((b) => b.startsWith('['))
          .map((b) => b.slice(1, -1))
          .filter((b) => b.trim().length > 0)
          .join(',')}]`;
  const header = (name: string) => [...pages].reverse().find((p) => p.headers[name] !== undefined)?.headers[name];
  const remaining = Number(header('x-ratelimit-remaining'));
  const reset = Number(header('x-ratelimit-reset'));
  return {
    status: last.status,
    etag: pages[0]!.headers['etag'],
    remaining: Number.isFinite(remaining) ? remaining : undefined,
    reset: Number.isFinite(reset) ? reset : undefined,
    body: merged,
  };
}
