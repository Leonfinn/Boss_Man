// BOS-1762: the landing turn. A ticket rebuilt twice because main moved after its checks passed takes its project's turn;
// other tickets' pushes wait for it, but never longer than the cap. The clock is injected: no test waits on the wall clock.
import { describe, expect, it } from "vitest";
import { LandingTurns, REBUILDS_FOR_TURN } from "../src/services/landing-turn.js";

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
});
