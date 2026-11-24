// BOS-2435: the git host's build result for each card in Review, cached so a board load never makes more than one host call per card in 5 minutes.
// BOS-2495: and the board never waits more than BOARD_BUILD_WAIT_MS for the host.
import type { CommitChecks } from "./git-hosts.js";

export type BoardBuild = { state: "passed" | "failed" | "running" | "none" | "unavailable"; failing: string[] };

export const BOARD_BUILD_TTL_MS = 5 * 60_000;

/**
 * `fetch` is `review.branchChecksOrThrow`: null when the company has no git host (no tag), a throw when the host fails (unavailable).
 * The key is the ticket plus its last activity, so new work on the branch (a new head) is fetched fresh.
 */
// shortcut: the board service is built before the review service, so the review service hands its lookup over here, per database; rebuilt at every start, nothing to lose.
const lookups = new WeakMap<object, ReturnType<typeof boardBuilds>>();

/** The review service calls this once when it is built, so the board can reach the git host without app.ts wiring it. */
export function registerBoardBuilds(db: object, fetch: Parameters<typeof boardBuilds>[0]): void {
  lookups.set(db, boardBuilds(fetch));
}

/** The board's lookup for this database: no entries until the review service has registered. */
export function boardBuildsFor(db: object): ReturnType<typeof boardBuilds> {
  return async (cards) => (await lookups.get(db)?.(cards)) ?? new Map();
}

/**
 * BOS-2495: how long a board load waits for the host before it answers without the missing tags. The board polls every
 * 10 s, so a slower answer still lands in the cache and shows on the next poll. Before this the board waited for every
 * Review card's two or three host calls (15 s timeout each): after a restart, or each time the cache expired, the board
 * showed "Loading tasks" for 9 s and more with 25 cards in Review.
 */
export const BOARD_BUILD_WAIT_MS = 300;

export function boardBuilds(fetch: (ticketId: string) => Promise<(CommitChecks & { sha: string }) | null>, now: () => number = Date.now, waitMs: number = BOARD_BUILD_WAIT_MS) {
  // shortcut: a 5-minute cache of the host's answer, safe to lose on restart (the next board load asks again); one entry per Review card, dropped when the card leaves Review.
  const cache = new Map<string, { key: string; at: number; value: BoardBuild | null }>();
  // The card's host lookup still going, so a poll that comes while it is out does not ask again.
  const inflight = new Map<string, Promise<void>>();
  const ask = (id: string, key: string, at: number) => {
    const p = (async () => {
      let value: BoardBuild | null;
      try {
        const r = await fetch(id);
        value = r ? { state: r.state === "pending" ? "running" : r.state, failing: r.failing } : null;
      } catch {
        value = { state: "unavailable", failing: [] };
      }
      cache.set(id, { key, at, value });
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  return async (cards: Array<{ id: string; activityKey: string }>): Promise<Map<string, BoardBuild>> => {
    const t = now();
    const live = new Set(cards.map((c) => c.id));
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    const asking: Array<Promise<void>> = [];
    for (const c of cards) {
      const key = `${c.id}|${c.activityKey}`;
      const hit = cache.get(c.id);
      if (hit && hit.key === key && t - hit.at < BOARD_BUILD_TTL_MS) continue;
      asking.push(inflight.get(key) ?? ask(c.id, key, t));
    }
    if (asking.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(asking), new Promise<void>((done) => (timer = setTimeout(done, waitMs)))]);
      clearTimeout(timer);
    }
    // A card whose new answer is still out shows its last one (an expired entry, or the one from before its newest
    // activity, which is usually the same head): a tag that blinks off on every poll would read as "no build" instead.
    const out = new Map<string, BoardBuild>();
    for (const c of cards) {
      const v = cache.get(c.id)?.value;
      if (v) out.set(c.id, v);
    }
    return out;
  };
}
