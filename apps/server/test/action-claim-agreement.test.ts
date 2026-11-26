// BOS-2737 (R60): every server "someone is on it" line is actionClaim's line for the same facts. One test per site:
// the board's Looks stuck line, the failed-update hold's pickup line, and the CEO plan reply. (The host panel's is in
// apps/web/test/host-facts-display.test.ts.) Each would fail if the site went back to a fixed string.
import { actionClaim } from "@boss-man/shared";
import { describe, expect, it } from "vitest";
import { looksStuck, type StuckFlag } from "../src/services/board-stuck.js";
import { planMoveWarning } from "../src/services/ceo-plan.js";
import { pickupWords, type Pickup } from "../src/services/owner-holds.js";

const now = new Date("2026-11-26T16:00:00Z");
const handed = new Date("2026-11-26T15:30:00Z");
const flag: StuckFlag = { rule: "stale_in_progress", openedAt: new Date("2026-11-26T12:00:00Z"), lastFlaggedAt: handed, detail: { idleMs: 4 * 3_600_000 } };
const plain = { beingChecked: false, nextUp: false, watching: false };

describe("board Looks stuck line (Board.tsx shows looksStuck.claim)", () => {
  it("a flag handed on with no Scrum Master run since: raised at HH:MM, nobody has picked it up yet", () => {
    const v = looksStuck(flag, plain, now)!;
    expect(v.claim).toBe("The Scrum Master was alerted: raised at 15:30 UTC, nobody has picked it up yet.");
    expect(v.claim).toBe(actionClaim({ who: "The Scrum Master", raisedAt: handed }).text);
  });

  it("names the Scrum Master's run once one started after the hand-off", () => {
    const smRun = { agent: "Sam", startedAt: new Date("2026-11-26T15:32:00Z") };
    expect(looksStuck(flag, { ...plain, smRun }, now)!.claim).toBe(actionClaim({ who: "The Scrum Master", raisedAt: handed, run: smRun }).text);
    expect(looksStuck(flag, { ...plain, smRun }, now)!.claim).toBe("Sam started work on it at 15:32 UTC.");
  });

  it("a Scrum Master run from before the hand-off does not count", () => {
    const smRun = { agent: "Sam", startedAt: new Date("2026-11-26T15:00:00Z") };
    expect(looksStuck(flag, { ...plain, smRun }, now)!.claim).toContain("nobody has picked it up yet");
  });
});

describe("failed-update hold pickup line (pickupWords)", () => {
  const p = (over: Partial<Pickup> = {}): Pickup => ({ ticketId: "t1", ref: "APP-19", agent: "Nova", startedAt: null, wokenAt: handed, ...over });
  const same = (x: Pickup, live = true) =>
    actionClaim({ who: "The CEO", raisedAt: x.agent ? null : x.wokenAt, ticket: x.ticketId && x.ref ? { ref: x.ref, agent: x.agent, wokenAt: x.agent ? x.wokenAt : null } : null, run: x.agent && x.startedAt ? { agent: x.agent, startedAt: x.startedAt } : null, live }).text;

  it.each([
    ["no ticket, CEO woken", p({ ticketId: null, ref: null, agent: null })],
    ["no ticket, nobody woken", p({ ticketId: null, ref: null, agent: null, wokenAt: null })],
    ["assigned, woken, no run", p()],
    ["run started", p({ startedAt: new Date("2026-11-26T15:40:00Z") })],
  ])("%s", (_, x) => {
    expect(pickupWords(x)).toBe(same(x));
    expect(pickupWords(x, false)).toBe(same(x, false));
  });
});

describe("CEO plan reply (planMoveWarning)", () => {
  const lead = "\n\nHeads up: the CEO set a plan for this ticket that has not expired yet, and in_progress -> blocked leaves it. Split it ";
  it("names the time the CEO's wake was sent", () => {
    expect(planMoveWarning("Split it", "in_progress", "blocked", false, handed)).toBe(`${lead}${actionClaim({ who: "The CEO", raisedAt: handed, live: false }).text}`);
  });
  it("never says the CEO was told when no wake went out", () => {
    const s = planMoveWarning("Split it", "in_progress", "blocked", false, null);
    expect(s).toBe(`${lead}Nobody has picked it up yet: the CEO has not been alerted.`);
    expect(s).not.toMatch(/has been told/);
  });
});
