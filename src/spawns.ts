import type { StoreLike } from './log.ts';

// what a subagent started with: the directory it runs in, and the plugin's tools it was given
export type Spawn = { cwd?: string; tools: string[] };

type Stored = Record<string, Spawn>;

// every subagent of the session as it was spawned, kept in the store so a reload keeps them. a subagent keeps the
// tool list it was spawned with, so what it can call is what was registered then, whatever a reload registered since
export class Spawns {
  private readonly spawns = new Map<string, Spawn>();
  private host?: { store: StoreLike; key: string };

  // restores what earlier environments recorded, under what this one recorded before it was bound
  async bind(store: StoreLike, key: string): Promise<void> {
    const stored = ((await store.get(key)) as Stored | undefined) ?? {};
    for (const [id, spawn] of Object.entries(stored)) if (!this.spawns.has(id)) this.spawns.set(id, spawn);
    this.host = { store, key };
    await this.save();
  }

  // a subagent spawned with no directory of its own runs in its parent's
  async spawned(agentId: string | undefined, cwd: string | undefined, parentId: string | undefined, tools: readonly string[]): Promise<void> {
    if (agentId === undefined) return;
    const dir = cwd ?? this.of(parentId);
    this.spawns.set(agentId, { ...(dir === undefined ? {} : { cwd: dir }), tools: [...tools] });
    await this.save();
  }

  of(agentId: string | undefined): string | undefined {
    return agentId === undefined ? undefined : this.spawns.get(agentId)?.cwd;
  }

  // whether the loop can call the tool: the main loop sees every tool registered, a subagent those registered when it
  // was spawned, and one whose spawn no environment recorded is not known to have any
  has(agentId: string | undefined, tool: string): boolean {
    if (agentId === undefined) return true;
    return this.spawns.get(agentId)?.tools.includes(tool) ?? false;
  }

  private async save(): Promise<void> {
    if (this.host) await this.host.store.set(this.host.key, Object.fromEntries(this.spawns));
  }
}
