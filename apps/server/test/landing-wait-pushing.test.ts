// BOS-2479: a runner swap waits for a merge only while its push to main is under way.
//
// 24 Nov 10:05: the runner update held every agent until 10:32 for BOS-2408, whose merge was "merging" but only waiting for
// a place in the merge train. The update's own hold stopped that merge from moving, so the landing wait could only end on
// its 20-minute cap. 17:22 the same day: BOS-2484 and BOS-2521, both waiting for a train seat, were named "being pushed to
// main". The phase "merging" is set at the start of every merge round, and landingMergeIds counted it minus a growing list of
// exceptions (GitHub CI, a queued merge check). Now it counts only the push call (merge-rounds.ts markPushing).
// All rows are made up; no real clocks are waited on.
import { describe, expect, it } from "vitest";
import { landingMergeIds, landingWaitFacts, pushingSince } from "../src/services/merge-status.js";
import { markPushing } from "../src/services/merge-rounds.js";
import { LANDING_END_MS } from "../src/services/update-waits.js";
import type { LandingStatus } from "../src/services/review-common.js";
import type { ReviewCtx } from "../src/services/review-ctx.js";
import type { ReviewSelf } from "../src/services/review.js";

type Phase = "queued" | "checking" | "merging" | "waiting_to_retry" | "retrying_git";

/** The parts of a review context the landing wait reads, with landings in the given phases. */
function fakeCtx(ids: string[], o: { phase?: Phase; stale?: string[] } = {}) {
  const landings = new Map<string, LandingStatus>(ids.map((id) => [id, { state: "running", startedAt: new Date(Date.now() - 60_000).toISOString(), command: null, startedBy: "Sam" }]));
  const phases = new Map<string, Phase>(ids.map((id) => [id, o.phase ?? "merging"]));
  const ciWaits = new Map<string, { since: number; waiting: string[] }>();
  const pushing = new Map<string, number>();
  const refs: Record<string, string> = { a: "BOS-2408", b: "BOS-2484", c: "BOS-2521" };
  const ctx = {
    landings,
    phases,
    ciWaits,
    pushing,
    landingStale: async (id: string) => (o.stale ?? []).includes(id),
    namedTickets: async (want: string[]) => want.map((id) => ({ ticketId: id, ref: refs[id] ?? null, title: "T" })),
  };
  const self = { landingMergeIds: () => landingMergeIds.call(self as unknown as ReviewSelf, ctx) } as unknown as ReviewSelf;
  const ids_ = () => landingMergeIds.call(self, ctx);
  const facts = () => landingWaitFacts.call(self, ctx as unknown as ReviewCtx);
  return { ctx, ids: ids_, facts };
}

describe("a landing counts for the runner swap only while it pushes (BOS-2479)", () => {
  it("(a) one merge in phase 'merging' waiting for a train seat, no check job: not counted (24 Nov 10:11, BOS-2408)", async () => {
    const f = fakeCtx(["a"]);
    expect(await f.ids()).toEqual([]);
    expect(await f.facts()).toEqual({ since: null, ids: [], names: [], endsAt: null });
  });

  it("(a2) two merges waiting for a train seat are neither counted nor named (24 Nov 17:22, BOS-2484 and BOS-2521)", async () => {
    const f = fakeCtx(["b", "c"]);
    expect(await f.ids()).toEqual([]);
    expect((await f.facts()).names).toEqual([]);
  });

  it("(b) a merge whose merge check is only queued, and (c) one waiting for GitHub CI: not counted", async () => {
    const queued = fakeCtx(["a"], { phase: "queued" });
    expect(await queued.ids()).toEqual([]);
    const ci = fakeCtx(["a"]);
    ci.ctx.ciWaits.set("a", { since: Date.now(), waiting: ["check"] });
    expect(await ci.ids()).toEqual([]);
  });

  it("(d) a push under way is counted and named by ticket reference, with when it began and its latest end", async () => {
    const f = fakeCtx(["a", "b"]);
    const at = Date.now() - 30_000;
    f.ctx.pushing.set("a", at);
    expect(await f.ids()).toEqual(["a"]);
    expect(await f.facts()).toEqual({ since: new Date(at).toISOString(), ids: ["a"], names: ["BOS-2408"], endsAt: new Date(at + LANDING_END_MS).toISOString() });
    expect(pushingSince(f.ctx, "a")).toBe(new Date(at).toISOString());
    expect(pushingSince(f.ctx, "b")).toBeNull();
  });

  it("(e) a push past its own end, a stale one, and a marker left on a finished landing are not counted", async () => {
    const old = fakeCtx(["a"]);
    old.ctx.pushing.set("a", Date.now() - LANDING_END_MS - 60_000);
    expect(await old.ids()).toEqual([]);
    const stale = fakeCtx(["a"], { stale: ["a"] });
    stale.ctx.pushing.set("a", Date.now());
    expect(await stale.ids()).toEqual([]);
    const ended = fakeCtx(["a"]);
    ended.ctx.pushing.set("a", Date.now());
    ended.ctx.landings.set("a", { state: "finished", outcome: "merged", text: "Merged", url: null, finishedAt: new Date().toISOString() });
    expect(await ended.ids()).toEqual([]);
    expect(pushingSince(ended.ctx, "a")).toBeNull();
  });
});

describe("markPushing: the marker covers the push call only (BOS-2479)", () => {
  it("(f) is set during the call, cleared when the call did not merge or threw, and kept after a merge", async () => {
    const pushing = new Map<string, number>();
    let during: number | undefined;
    const moved = await markPushing(pushing, "t", async () => {
      during = pushing.get("t");
      return { status: "main_moved" };
    });
    expect(moved.status).toBe("main_moved");
    expect(during).toEqual(expect.any(Number));
    expect(pushing.has("t")).toBe(false);

    await expect(markPushing(pushing, "t", async () => Promise.reject(new Error("runner gone")))).rejects.toThrow("runner gone");
    expect(pushing.has("t")).toBe(false);

    // A merged push stays counted until land() ends and clears it (the record is written first, BOS-1645).
    await markPushing(pushing, "t", async () => ({ status: "merged" }));
    expect(pushing.has("t")).toBe(true);
  });
});
