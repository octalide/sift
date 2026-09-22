// the prompt origins that are a person's request; anything else (a plugin's prompt, a task notification, a peer)
// arrives in the main loop without changing what it is working on
export const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk'];

// the marker that keeps one Bash command's output whole
export const FULL_MARKER = /#\s*sift:\s*full\b/;

// the tool the model turns prune off and on with, as the model sees it
export const PRUNE_TOOL = 'mcp__sift__prune';

// a tool call as prune reads it: the tool, its input, and the loop it ran in (absent on the main loop)
export type PruneCall = { tool: string; input: Record<string, unknown>; agentId?: string };

// until the loop's next task, or for this many more outputs prune would otherwise judge
type OptOut = { calls?: number };

type Loop = {
  task: string;
  // what this loop's task had output dropped from: `Read <path>` or `Bash <command>`
  pruned: Set<string>;
  off?: OptOut;
};

const MAIN = '';

function targetOf(call: PruneCall): string | undefined {
  if (call.tool === 'Read' && typeof call.input['file_path'] === 'string') return `Read ${call.input['file_path']}`;
  if (call.tool === 'Bash' && typeof call.input['command'] === 'string') return `Bash ${call.input['command'].trim()}`;
  return undefined;
}

// the path-like words of a task: a slash or a file extension, with a trailing :line or :from-to cut off
export function pathsIn(text: string): string[] {
  return text
    .split(/[\s`'"()<>[\]{},;|]+/)
    .map((w) => w.replace(/(:\d+(-\d+)?)+$/, '').replace(/[.:!?]+$/, '').replace(/^\.\//, ''))
    .filter((w) => w.length >= 3 && !w.endsWith('/') && (w.includes('/') || /\.[A-Za-z0-9]+$/.test(w)) && !/^[a-z]+:\/\//i.test(w));
}

function names(task: string, path: string): boolean {
  return pathsIn(task).some((p) => path === p || path.endsWith(p.startsWith('/') ? p : `/${p}`));
}

// per model loop: the task prune judges against, what it already pruned for that task, and whether it is turned off
export class PruneLoops {
  private readonly loops = new Map<string, Loop>();

  // a subagent's task is the prompt it was spawned with
  spawned(agentId: string | undefined, prompt: string): void {
    if (agentId !== undefined) this.loops.set(agentId, { task: prompt, pruned: new Set() });
  }

  // the main loop's task is the newest prompt a person submitted
  submitted(origin: string, text: string): void {
    if (PERSON_ORIGINS.includes(origin) && text.trim().length > 0) this.loops.set(MAIN, { task: text, pruned: new Set() });
  }

  task(agentId: string | undefined): string | undefined {
    return this.loops.get(agentId ?? MAIN)?.task;
  }

  // off until the loop's next task, or for calls outputs; on turns it back on
  control(agentId: string | undefined, action: 'off' | 'on', calls?: number): string {
    const loop = this.loops.get(agentId ?? MAIN);
    if (!loop) return 'prune: no task recorded for this loop, so nothing is pruned in it yet';
    if (action === 'on') {
      delete loop.off;
      return 'prune on for this loop';
    }
    const n = calls !== undefined && Number.isFinite(calls) && calls >= 1 ? Math.floor(calls) : undefined;
    loop.off = n === undefined ? {} : { calls: n };
    return n === undefined ? 'prune off for this loop until its next task' : `prune off for this loop for its next ${n} output${n === 1 ? '' : 's'} over the floor`;
  }

  // why this call's output passes untouched without a judge call, or undefined when it is judged
  backoff(call: PruneCall): string | undefined {
    const loop = this.loops.get(call.agentId ?? MAIN);
    if (!loop) return 'no task recorded for this loop';
    if (loop.off) {
      if (loop.off.calls !== undefined && --loop.off.calls <= 0) delete loop.off;
      return 'prune off for this loop';
    }
    if (call.tool === 'Bash' && typeof call.input['command'] === 'string' && FULL_MARKER.test(call.input['command'])) return 'command marked # sift: full';
    if (call.tool === 'Read' && (call.input['offset'] !== undefined || call.input['limit'] !== undefined)) return 'targeted read (offset or limit)';
    const target = targetOf(call);
    if (target !== undefined && loop.pruned.has(target)) return `${call.tool === 'Read' ? 'path' : 'command'} pruned earlier in this task`;
    if (call.tool === 'Read' && typeof call.input['file_path'] === 'string' && names(loop.task, call.input['file_path'])) return 'path named in the task';
    return undefined;
  }

  // output of this call was dropped: a repeat of it in the same task is a sign the drop was wrong
  pruned(call: PruneCall): void {
    const target = targetOf(call);
    if (target !== undefined) this.loops.get(call.agentId ?? MAIN)?.pruned.add(target);
  }
}
