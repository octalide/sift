import type { Judge } from '../judge/types.ts';
import { runPack } from '../packs/run.ts';
import type { Pack } from '../packs/types.ts';
import type { RepoConfig } from '../github/config.ts';
import { textSubject } from '../github/subjects.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function clampEffort(e: Effort, min: Effort, max: Effort): Effort {
  const i = EFFORTS.indexOf(e);
  const lo = EFFORTS.indexOf(min);
  const hi = EFFORTS.indexOf(max);
  return EFFORTS[Math.min(Math.max(i, lo), hi)]!;
}

export type RouteDecision = { effort?: Effort; label: string };

export async function routeEffort(prompt: string, pack: Pack, judge: Judge, config: RepoConfig, min: Effort, max: Effort): Promise<RouteDecision> {
  const report = await runPack(pack, textSubject(prompt), judge, config);
  const effort = report.judged.find((j) => j.id === 'effort');
  if (report.judgeError || !effort || effort.answer.type !== 'score') return { label: `no route (${report.judgeError ?? 'no answer'})` };
  if (effort.band !== 'satisfied') return { label: `unclear (${effort.answer.confidence.toFixed(2)}), session effort kept` };
  const chosen = (['low', 'medium', 'high'] as Effort[])[effort.answer.score] ?? 'high';
  return { effort: clampEffort(chosen, min, max), label: `${chosen} (${effort.answer.confidence.toFixed(2)})` };
}
