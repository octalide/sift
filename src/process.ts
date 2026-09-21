export type RunLike = (
  argv: readonly string[],
  init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

// where a spawn runs, resolved per call so a directory removed after session start is never reused
export type CwdLike = () => Promise<string | undefined>;
