// BOS-2435: the git host's build result for each card in Review, cached so a board load never makes more than one host call per card in 5 minutes.
import type { CommitChecks } from "./git-hosts.js";

export type BoardBuild = { state: "passed" | "failed" | "running" | "none" | "unavailable"; failing: string[] };

export const BOARD_BUILD_TTL_MS = 5 * 60_000;

/**
 * `fetch` is `review.branchChecksOrThrow`: null when the company has no git host (no tag), a throw when the host fails (unavailable).
 * The key is the ticket plus its last activity, so new work on the branch (a new head) is fetched fresh.
 */
export function boardBuilds(fetch: (ticketId: string) => Promise<(CommitChecks & { sha: string }) | null>, now: () => number = Date.now) {
  // shortcut: a 5-minute cache of the host's answer, safe to lose on restart (the next board load asks again); one entry per Review card, dropped when it expires.
  const cache = new Map<string, { at: number; value: BoardBuild | null }>();
  return async (cards: Array<{ id: string; activityKey: string }>): Promise<Map<string, BoardBuild>> => {
    const out = new Map<string, BoardBuild>();
    const t = now();
    const live = new Set(cards.map((c) => c.id));
    for (const [k, v] of cache) if (t - v.at >= BOARD_BUILD_TTL_MS || !live.has(k.split("|")[0]!)) cache.delete(k);
    await Promise.all(
      cards.map(async (c) => {
        const key = `${c.id}|${c.activityKey}`;
        let hit = cache.get(key);
        if (!hit) {
          let value: BoardBuild | null;
          try {
            const r = await fetch(c.id);
            value = r ? { state: r.state === "pending" ? "running" : r.state, failing: r.failing } : null;
          } catch {
            value = { state: "unavailable", failing: [] };
          }
          hit = { at: t, value };
          cache.set(key, hit);
        }
        if (hit.value) out.set(c.id, hit.value);
      }),
    );
    return out;
  };
}
