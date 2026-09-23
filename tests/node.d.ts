// the few node apis the tests use; the project carries no node types
declare module 'node:child_process' {
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: { cwd?: string; encoding: 'utf8'; input?: string; env?: Record<string, string | undefined> },
  ): { status: number | null; stdout: string; stderr: string };
}

declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { size: number; mtimeMs: number; isFile(): boolean; isDirectory(): boolean };
  export function readdirSync(path: string, options: { withFileTypes: true }): { name: string; isFile(): boolean; isDirectory(): boolean }[];
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  export function utimesSync(path: string, atime: number, mtime: number): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

// a macrotask boundary, so every pending microtask has run before a test goes on
declare module 'node:timers/promises' {
  export function setImmediate(): Promise<void>;
}
