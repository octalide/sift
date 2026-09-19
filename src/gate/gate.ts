import type { Judge } from '../judge/types.ts';
import { runPack } from '../packs/run.ts';
import type { Pack, Report, Subject } from '../packs/types.ts';
import type { RepoConfig } from '../github/config.ts';
import { truncate } from '../tokens.ts';

export type GateInput = {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  repoRoot?: string;
  task: string;
};

// commands that should never leave the machine, judged or not
const SECRET = /\b(id_rsa|id_ed25519|\.pem\b|\.netrc|\.npmrc|\.pypirc|aws\/credentials|\.env\b|TOKEN|SECRET|PASSWORD|API_KEY)/i;

export function commandSubject(g: GateInput): Subject {
  const summary =
    g.tool === 'Bash'
      ? { command: truncate(String(g.input['command'] ?? ''), 4000), description: g.input['description'] ?? null }
      : { path: g.input['file_path'] ?? null, size: typeof g.input['content'] === 'string' ? g.input['content'].length : undefined, old: truncate(String(g.input['old_string'] ?? ''), 500), new: truncate(String(g.input['new_string'] ?? ''), 500) };
  return {
    kind: 'command',
    ref: `${g.tool}`,
    state: { tool: g.tool, ...summary, cwd: g.cwd, repo_root: g.repoRoot ?? null, task: truncate(g.task, 2000) },
    facts: {},
    options: {},
  };
}

export function mentionsSecret(g: GateInput): boolean {
  const text = g.tool === 'Bash' ? String(g.input['command'] ?? '') : `${String(g.input['file_path'] ?? '')} ${String(g.input['content'] ?? '')} ${String(g.input['new_string'] ?? '')}`;
  return SECRET.test(text);
}

export type GateDecision = { allow: boolean; reason: string; report?: Report };

export async function gate(g: GateInput, pack: Pack, judge: Judge, config: RepoConfig, failClosed: boolean): Promise<GateDecision> {
  const report = await runPack(pack, commandSubject(g), judge, config);
  if (report.judgeError) return { allow: true, reason: `judge unavailable (${report.judgeError})`, report };
  const violated = report.judged.filter((j) => j.band === 'violated' && j.severity === 'fail');
  if (violated.length > 0) return { allow: false, reason: violated.map((j) => j.id).join(', '), report };
  const unclear = report.judged.filter((j) => j.band === 'unclear' && j.severity === 'fail');
  if (unclear.length > 0 && failClosed) return { allow: false, reason: `unclear: ${unclear.map((j) => j.id).join(', ')}`, report };
  return { allow: true, reason: 'clear', report };
}
