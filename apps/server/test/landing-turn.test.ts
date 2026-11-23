// BOS-1762: the landing turn. A ticket rebuilt twice because main moved after its checks passed takes its project's turn;
// other tickets' pushes wait for it, but never longer than the cap. The clock is injected: no test waits on the wall clock.
import { describe, expect, it } from "vitest";
import { LandingTurns, REBUILDS_FOR_TURN } from "../src/services/landing-turn.js";
import { holderPhase } from "../src/services/merge-status.js";

const P = "project-1";
const HOUR = 60 * 60_000;

function turns() {
  let now = 1_000_000;
  const t = new LandingTurns(() => now);
  return { t, advance: (ms: number) => (now += ms) };
}

describe("landing turns (BOS-1762)", () => {
  it("is taken on the second rebuild, and then another ticket's push waits", () => {
    const { t } = turns();
    expect(REBUILDS_FOR_TURN).toBe(2);
    expect(t.rebuilt(P, "a", HOUR)).toEqual({ count: 1, turn: null });
    expect(t.blocks(P, "b")).toBe(false);
    expect(t.rebuilt(P, "a", HOUR)).toEqual({ count: 2, turn: "taken" });
    expect(t.holds(P, "a")).toBe(true);
    expect(t.blocks(P, "b")).toBe(true);
    expect(t.blocks(P, "a")).toBe(false);
    // Another project is not held.
    expect(t.blocks("project-2", "b")).toBe(false);
  });

  it("one turn per project: a second ticket that earns it is next in line and takes it when the first lands", () => {
    const { t } = turns();
    t.rebuilt(P, "a", HOUR);
    t.rebuilt(P, "a", HOUR);
    t.rebuilt(P, "b", HOUR);
    expect(t.rebuilt(P, "b", HOUR)).toEqual({ count: 2, turn: "queued" });
    expect(t.blocks(P, "b")).toBe(true);
    expect(t.done(P, "a")).toBe(true);
    expect(t.holds(P, "b")).toBe(true);
    expect(t.blocks(P, "a")).toBe(true);
    expect(t.done(P, "b")).toBe(true);
    expect(t.check(P).holder).toBeNull();
  });

  it("ends at the cap, says which turn expired, and isn't taken again by the same merge", () => {
    const { t, advance } = turns();
    t.rebuilt(P, "a", HOUR);
    t.rebuilt(P, "a", HOUR);
    advance(HOUR - 1);
    expect(t.blocks(P, "b")).toBe(true);
    advance(1);
    const c = t.check(P);
    expect(c.holder).toBeNull();
    expect(c.expired).toMatchObject({ ticketId: "a" });
    expect(t.blocks(P, "b")).toBe(false);
    // More rebuilds in the same merge don't take it again.
    expect(t.rebuilt(P, "a", HOUR)).toEqual({ count: 3, turn: null });
    // Once its merge ends (landed, failed, left review) the count starts again.
    t.done(P, "a");
    expect(t.rebuilt(P, "a", HOUR)).toEqual({ count: 1, turn: null });
  });

  it("an expired turn passes to the next in line, with a cap of its own from then", () => {
    const { t, advance } = turns();
    t.rebuilt(P, "a", HOUR);
    t.rebuilt(P, "a", HOUR);
    advance(HOUR / 2);
    t.rebuilt(P, "b", HOUR);
    t.rebuilt(P, "b", HOUR);
    advance(HOUR / 2);
    expect(t.check(P)).toMatchObject({ holder: { ticketId: "b" }, expired: { ticketId: "a" } });
    advance(HOUR - 1);
    expect(t.holds(P, "b")).toBe(true);
  });

  it("a ticket that leaves the line (done) gives up its place in the queue too", () => {
    const { t } = turns();
    t.rebuilt(P, "a", HOUR);
    t.rebuilt(P, "a", HOUR);
    t.rebuilt(P, "b", HOUR);
    t.rebuilt(P, "b", HOUR);
    expect(t.done(P, "b")).toBe(false);
    t.done(P, "a");
    expect(t.check(P).holder).toBeNull();
  });

  it("cap 0 means no turns at all", () => {
    const { t } = turns();
    t.rebuilt(P, "a", 0);
    expect(t.rebuilt(P, "a", 0)).toEqual({ count: 2, turn: null });
    expect(t.blocks(P, "b")).toBe(false);
  });

  it("counts the gate's pushes to each project's main, so a waiting merge knows when to ask again (BOS-1821)", () => {
    const { t } = turns();
    expect(t.mainEpoch(P)).toBe(0);
    t.landed(P);
    t.landed(P);
    expect(t.mainEpoch(P)).toBe(2);
    expect(t.mainEpoch("project-2")).toBe(0);
    // A turn ending is not a push: the count moves only on landed.
    t.rebuilt(P, "a", HOUR);
    t.rebuilt(P, "a", HOUR);
    t.done(P, "a");
    expect(t.mainEpoch(P)).toBe(2);
  });

  // BOS-2119: a merge in line waits to re-prepare until it holds the turn, so it must be able to ask whether it is in line.
  it("queued() and line() follow the line through promote, expire and done", () => {
    const { t, advance } = turns();
    const earn = (id: string) => [t.rebuilt(P, id, HOUR), t.rebuilt(P, id, HOUR)][1]!.turn;
    expect(earn("a")).toBe("taken");
    expect(earn("b")).toBe("queued");
    expect(earn("c")).toBe("queued");
    expect(t.line(P)).toEqual(["b", "c"]);
    expect([t.queued(P, "a"), t.queued(P, "b"), t.queued(P, "c"), t.queued("project-2", "b")]).toEqual([false, true, true, false]);
    expect(t.snapshot()).toEqual([{ projectId: P, holder: expect.objectContaining({ ticketId: "a", capMs: HOUR }), line: ["b", "c"] }]);
    // a lands: b is promoted and leaves the line.
    t.done(P, "a");
    expect([t.holds(P, "b"), t.queued(P, "b")]).toEqual([true, false]);
    expect(t.line(P)).toEqual(["c"]);
    // b's turn runs out: c is promoted.
    advance(HOUR);
    expect(t.check(P)).toMatchObject({ holder: { ticketId: "c" }, expired: { ticketId: "b" } });
    expect(t.line(P)).toEqual([]);
    expect(t.queued(P, "c")).toBe(false);
    // A ticket that leaves the line while in it (done) is no longer queued.
    expect(earn("d")).toBe("queued");
    t.done(P, "d");
    expect(t.queued(P, "d")).toBe(false);
    t.done(P, "c");
    expect(t.snapshot()).toEqual([]);
  });
});

// BOS-2361: a promotion is recorded like a direct take, and snapshot() releases a turn past its cap.
describe("landing turn events (BOS-2361)", () => {
  const earn = (t: LandingTurns, id: string, cap = HOUR) => {
    t.rebuilt(P, id, cap);
    return t.rebuilt(P, id, cap).turn;
  };

  it("promoting the next in line reports a taken event (done and expiry); a direct take reports none itself", () => {
    const { t, advance } = turns();
    const seen: unknown[] = [];
    t.onEvent = (e) => seen.push(e);
    expect(earn(t, "a")).toBe("taken");
    expect(earn(t, "b", 2 * HOUR)).toBe("queued");
    expect(earn(t, "c")).toBe("queued");
    expect(seen).toEqual([]);
    t.done(P, "a");
    expect(seen).toEqual([{ action: "taken", projectId: P, ticketId: "b", capMs: 2 * HOUR }]);
    advance(2 * HOUR);
    t.check(P);
    expect(seen[1]).toEqual({ action: "taken", projectId: P, ticketId: "c", capMs: HOUR });
  });

  it("snapshot releases a turn past its cap, reports it expired, and shows the next in line as holder", () => {
    const { t, advance } = turns();
    const seen: Array<{ action: string; ticketId: string }> = [];
    t.onEvent = (e) => seen.push(e);
    earn(t, "a");
    earn(t, "b");
    advance(HOUR);
    const snap = t.snapshot();
    expect(snap).toEqual([{ projectId: P, holder: expect.objectContaining({ ticketId: "b" }), line: [] }]);
    expect(seen.map((e) => `${e.action}:${e.ticketId}`)).toEqual(["taken:b", "expired:a"]);
    // A second look reports nothing more.
    t.snapshot();
    expect(seen).toHaveLength(2);
  });

  it("snapshot with no one in line drops an expired turn entirely", () => {
    const { t, advance } = turns();
    const seen: Array<{ action: string; ticketId: string }> = [];
    t.onEvent = (e) => seen.push(e);
    earn(t, "a");
    advance(HOUR);
    expect(t.snapshot()).toEqual([]);
    expect(seen).toEqual([{ action: "expired", projectId: P, ticketId: "a", capMs: HOUR }]);
  });
});

describe("holderPhase (BOS-2361)", () => {
  const ctx = (p: { running?: boolean; phase?: string; ci?: number; turn?: boolean }) =>
    ({
      landings: new Map(p.running === false ? [] : [["a", { state: "running" }]]),
      phases: new Map(p.phase ? [["a", p.phase]] : []),
      ciWaits: new Map(p.ci ? [["a", { since: p.ci, waiting: [] }]] : []),
      turnWaits: new Map(p.turn ? [["a", {}]] : []),
    }) as never;

  it("says what the holder's merge is doing", () => {
    expect(holderPhase(ctx({ phase: "checking" }), "a")).toBe("merge check");
    expect(holderPhase(ctx({ phase: "merging" }), "a")).toBe("building the merge copy or pushing");
    expect(holderPhase(ctx({ ci: Date.parse("2026-11-23T14:05:30Z") }), "a")).toBe("waiting for GitHub CI since 14:05 UTC");
    expect(holderPhase(ctx({ turn: true }), "a")).toBe("waiting for another ticket's landing turn");
    expect(holderPhase(ctx({ running: false }), "a")).toBe("no merge running");
  });
});
