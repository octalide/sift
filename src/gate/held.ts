import type { StoreLike } from '../log.ts';
import type { PostInput } from './post.ts';

// a post held while its rules are found: the caller it answers (unset for the main loop) and the input it was made with
export type HeldPost = { id: string; to?: string; input: PostInput; at: number };

export type HeldHost = {
  store: StoreLike;
  // the session's held posts key
  key: string;
  // whether this environment still holds the session
  holds: () => Promise<boolean>;
  now: () => number;
  id: () => string;
};

// the session's held posts, kept in the store so a reload hands them on. the environment that held a post makes it
// only after claiming it, which fails once a reload replaced that environment; the one that replaced it takes over
// every post still held and makes it itself, so a held post is made once and its caller always hears how it went
export class HeldPosts {
  constructor(private readonly host: HeldHost) {}

  async keep(to: string | undefined, input: PostInput): Promise<string> {
    // a write from a replaced environment is dropped, and the post with it
    if (!(await this.host.holds())) throw new Error('a reload replaced this sift environment while the post was made, so it was not held and nothing was written. Make the post again');
    const id = this.host.id();
    await this.host.store.set(this.host.key, [...(await this.all()), { id, ...(to === undefined ? {} : { to }), input, at: this.host.now() }]);
    return id;
  }

  // true when this environment still holds the session and the post, which it now makes; false once a reload took it over
  async claim(id: string): Promise<boolean> {
    if (!(await this.host.holds())) return false;
    const all = await this.all();
    if (!all.some((p) => p.id === id)) return false;
    await this.host.store.set(this.host.key, all.filter((p) => p.id !== id));
    return true;
  }

  // every post an environment a reload replaced left held, taken to be made here
  async takeOver(): Promise<HeldPost[]> {
    const all = await this.all();
    if (all.length > 0) await this.host.store.set(this.host.key, []);
    return all;
  }

  private async all(): Promise<HeldPost[]> {
    return ((await this.host.store.get(this.host.key)) as HeldPost[] | undefined) ?? [];
  }
}
