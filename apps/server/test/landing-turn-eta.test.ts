// BOS-2359: the landing turn's holder, what it waits for and an estimated land time on the Merges tab (built on BOS-1517's status
// line), and one CEO alert when a turn is held for over twice the usual GitHub wait, which closes itself when the turn ends.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, companies, decisions, projects, reviewRequests, tickets } from "../src/db/schema.js";
import { alertClearing, clearWhenOf } from "../src/services/alert-clearing.js";
import { kindCeiling } from "../src/services/alert-kinds.js";
import { landingEtas, landingTurnAlertKey, landingTurnAlertSweep, lineClearAt, median, turnOverdue, usualCiWait } from "../src/services/landing-turn-eta.js";
import { lineEvent } from "../src/services/merge-line.js";
import { mergeQueueService } from "../src/services/merge-queue.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
let companyId: string;
let projectId: string;

const MIN = 60_000;
const T0 = new Date("2026-11-23T15:00:00Z");
const at = (mins: number) => new Date(T0.getTime() + mins * MIN);

beforeEach(async () => {
  ({ db, close } = await openPglite());
  const [c] = await db.insert(companies).values({ name: "Co", ticketPrefix: "BOS" }).returning();
  companyId = c!.id;
  const [p] = await db.insert(projects).values({ companyId, name: "App" }).returning();
  projectId = p!.id;
  await db.insert(agents).values({ companyId, name: "Boss", role: "ceo", agentKind: "claude" });
});
afterEach(async () => {
  await close();
});

/** A landing whose GitHub wait ended `outcome` after `waitedMin` minutes, `agoMin` minutes before T0. */
async function ciWait(waitedMin: number, outcome = "passed", agoMin = 60) {
  const [t] = await db.insert(tickets).values({ companyId, projectId, title: "Past landing", systemState: "done" }).returning();
  await lineEvent(db, { id: t!.id, companyId }, { event: "ci_wait_ended", commit: "a".repeat(40), outcome, waitedMs: waitedMin * MIN }, at(-agoMin));
}

describe("median and the usual GitHub wait", () => {
  it("takes the middle value, or the mean of the middle two", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it("is the median of recent passed waits only, and nothing with fewer than three", async () => {
    await ciWait(22);
    await ciWait(24);
    expect(await usualCiWait(db, companyId, T0)).toBeNull();
    await ciWait(23);
    expect(await usualCiWait(db, companyId, T0)).toEqual({ ms: 23 * MIN, samples: 3 });
    // A failed or timed-out wait, and one older than 14 days, don't count.
    await ciWait(90, "timeout");
    await ciWait(1, "failed");
    await ciWait(500, "passed", 15 * 24 * 60);
    expect(await usualCiWait(db, companyId, T0)).toEqual({ ms: 23 * MIN, samples: 3 });
  });
});

describe("estimates and the 2x rule", () => {
  it("lands the holder one usual wait after its GitHub run began, and each ticket in line one wait after the one before", () => {
    const e = landingEtas({ holderSinceMs: at(-5).getTime(), ciSinceMs: at(-3).getTime(), lineIds: ["a", "b"], usualMs: 23 * MIN, nowMs: T0.getTime() });
    expect(e.holder).toBe(at(20).getTime());
    expect(e.line.get("a")).toBe(at(43).getTime());
    expect(e.line.get("b")).toBe(at(66).getTime());
  });

  it("never says a time already past, and guesses nothing without a usual wait", () => {
    expect(landingEtas({ holderSinceMs: at(-60).getTime(), ciSinceMs: at(-50).getTime(), lineIds: [], usualMs: 23 * MIN, nowMs: T0.getTime() }).holder).toBe(T0.getTime());
    expect(landingEtas({ holderSinceMs: at(-5).getTime(), ciSinceMs: null, lineIds: ["a"], usualMs: null, nowMs: T0.getTime() })).toEqual({ holder: null, line: new Map() });
  });

  it("is overdue only past twice the usual wait", () => {
    expect(turnOverdue(at(-46).getTime(), 23 * MIN, T0.getTime())).toBe(false);
    expect(turnOverdue(at(-47).getTime(), 23 * MIN, T0.getTime())).toBe(true);
    expect(turnOverdue(at(-500).getTime(), null, T0.getTime())).toBe(false);
  });
});

describe("the Merges tab", () => {
  async function inReview(title: string, number: number) {
    const [t] = await db.insert(tickets).values({ companyId, projectId, title, number, systemState: "review" }).returning();
    await db.insert(reviewRequests).values({ ticketId: t!.id, kind: "code", round: 1, status: "approved" });
    return t!;
  }

  it("names the holder, what it waits for and an estimated land time on the status lines of the holder and the ticket behind it", async () => {
    for (const m of [22, 24, 23]) await ciWait(m);
    const holder = await inReview("Holder change", 2337);
    const next = await inReview("Next in line", 2340);
    const svc = mergeQueueService(db, {
      runningMerges: () => [
        { ticketId: holder.id, startedAt: at(-10).toISOString(), startedBy: "gate", ci: { since: at(-8).toISOString(), waiting: ["check"] } },
        { ticketId: next.id, startedAt: at(-9).toISOString(), startedBy: "gate", turn: { holderId: holder.id, since: at(-9).getTime(), then: "rebuild" } },
      ],
      limit: async () => 2,
      runningChecks: async () => [],
      queueStatus: async () => ({ mode: "server", slots: 2, running: 0, waiting: 0 }),
      landingTurns: async () => [
        { projectId, holder: { ticketId: holder.id, ref: "BOS-2337", title: "Holder change", since: at(-10).toISOString() }, line: [{ ticketId: next.id, ref: "BOS-2340", title: "Next in line" }] },
      ],
      usualCiWait: (id) => usualCiWait(db, id, T0),
      now: () => T0,
    });
    const view = await svc.get(companyId);
    expect(view.landingTurns).toHaveLength(1);
    const turn = view.landingTurns![0]!;
    expect(turn.holder).toMatchObject({ ref: "BOS-2337", waitingFor: "GitHub run", waitingSince: at(-8).toISOString(), landsAt: at(15).toISOString(), overdue: false });
    expect(turn.usualWaitMin).toBe(23);
    expect(turn.line[0]).toMatchObject({ ref: "BOS-2340", landsAt: at(38).toISOString() });
    // The same estimate sits on the ticket's one status line (BOS-1517), not on a second line.
    expect(view.waiting.find((w) => w.ticketId === holder.id)?.statusLine?.landsAt).toBe(at(15).toISOString());
    expect(view.waiting.find((w) => w.ticketId === next.id)?.statusLine?.landsAt).toBe(at(38).toISOString());
  });

  it("BOS-2505: the view carries the one figure for when the line clears, with no landing turns (the train runs), and none without usual times", async () => {
    for (const m of [22, 24, 23]) await ciWait(m);
    const a = await inReview("In its GitHub wait", 2501);
    const deps = {
      runningMerges: () => [{ ticketId: a.id, startedAt: at(-10).toISOString(), startedBy: "gate", ci: { since: at(-8).toISOString(), waiting: ["check"] } }],
      limit: async () => 2,
      runningChecks: async () => [],
      queueStatus: async () => ({ mode: "server" as const, slots: 2, running: 0, waiting: 0 }),
      usualCiWait: (id: string) => usualCiWait(db, id, T0),
      now: () => T0,
    };
    // No landingTurns dep at all: the estimate must not need them.
    const withCheck = mergeQueueService(db, { ...deps, usualMergeCheck: async () => ({ ms: 20 * 60_000, samples: 5 }) });
    expect((await withCheck.get(companyId)).clearAt).toBe(at(15).toISOString());
    const without = mergeQueueService(db, { ...deps, usualMergeCheck: async () => null });
    expect((await without.get(companyId)).clearAt).toBeNull();
  });

  it("shows the holder with no estimate, and no overdue flag, while there are too few landings to call a wait usual", async () => {
    const holder = await inReview("Holder change", 2337);
    const svc = mergeQueueService(db, {
      runningMerges: () => [{ ticketId: holder.id, startedAt: at(-300).toISOString(), startedBy: "gate", ci: { since: at(-299).toISOString(), waiting: [] } }],
      limit: async () => 2,
      runningChecks: async () => [],
      queueStatus: async () => ({ mode: "server", slots: 2, running: 0, waiting: 0 }),
      landingTurns: async () => [{ projectId, holder: { ticketId: holder.id, ref: "BOS-2337", title: "Holder change", since: at(-300).toISOString() }, line: [] }],
      usualCiWait: (id) => usualCiWait(db, id, T0),
      now: () => T0,
    });
    const turn = (await svc.get(companyId)).landingTurns![0]!;
    expect(turn.holder).toMatchObject({ landsAt: null, overdue: false });
    expect(turn.usualWaitMin).toBeNull();
  });
});

// BOS-2505: when the last ticket of the merge line lands (the banner's figure).
describe("lineClearAt", () => {
  const MIN = 60_000;
  const NOW0 = Date.UTC(2026, 10, 24, 13, 25);
  const base = { nowMs: NOW0, usualCheckMs: 20 * MIN, usualCiMs: 20 * MIN, slots: 3, ciOnlySinceMs: [] as number[] };

  it("says nothing without a usual check time and a usual GitHub wait", () => {
    expect(lineClearAt({ ...base, usualCheckMs: null, running: [], queued: 1 })).toBeNull();
    expect(lineClearAt({ ...base, usualCiMs: null, running: [], queued: 1 })).toBeNull();
    expect(lineClearAt({ ...base, running: [], queued: 0 })).toBeNull(); // an empty line has no last landing
  });

  it("counts the tickets ahead of the waiting ones: checks 23, 12, 3 min in, one in its GitHub wait, two queued", () => {
    const running = [23, 12, 3].map((m) => ({ startedMs: NOW0 - m * MIN, ciSinceMs: null }));
    const at = lineClearAt({ ...base, running, ciOnlySinceMs: [NOW0 - 5 * MIN], queued: 2 })!;
    // The queued ones take the slots as they free (+1 and +8 min) and each needs 20 min: the last is ready at +28 min.
    expect((at - NOW0) / MIN).toBe(28);
    // Without the queued two, the last of the five is the check 3 min in (+17 min): the tickets behind do add time.
    expect((lineClearAt({ ...base, running, ciOnlySinceMs: [NOW0 - 5 * MIN], queued: 0 })! - NOW0) / MIN).toBe(17);
  });

  it("a ticket past its check, in its GitHub wait, lands one usual wait after the run began", () => {
    expect(lineClearAt({ ...base, running: [], ciOnlySinceMs: [NOW0 - 5 * MIN], queued: 0 })).toBe(NOW0 + 15 * MIN);
  });

  it("the check and the GitHub run go side by side: a ticket lands when both are done, not after one then the other", () => {
    // Check 5 min in (15 left), GitHub run began 12 min ago (8 left): ready at +15, not +15 + 20.
    expect(lineClearAt({ ...base, running: [{ startedMs: NOW0 - 5 * MIN, ciSinceMs: NOW0 - 12 * MIN }], queued: 0 })).toBe(NOW0 + 15 * MIN);
  });

  it("tickets that finish together land together: more of them do not push the last landing out", () => {
    const a = { startedMs: NOW0 - 10 * MIN, ciSinceMs: null };
    const b = { startedMs: NOW0 - 12 * MIN, ciSinceMs: null };
    expect(lineClearAt({ ...base, running: [a, b], queued: 0 })).toBe(NOW0 + 10 * MIN);
    expect(lineClearAt({ ...base, running: [a], queued: 0 })).toBe(NOW0 + 10 * MIN);
  });

  it("a check past the usual time counts one more minute, not zero or negative", () => {
    expect(lineClearAt({ ...base, running: [{ startedMs: NOW0 - 90 * MIN, ciSinceMs: null }], queued: 0 })).toBe(NOW0 + MIN);
  });
});

describe("the CEO alert", () => {
  const held = (sinceMin: number) => async () => [{ projectId, ticketId: "t1", ref: "BOS-2337", title: "Holder change", sinceMs: at(sinceMin).getTime(), waitingFor: "its GitHub run (started 14:52 UTC)" }];
  const sweep = (heldFn: () => ReturnType<ReturnType<typeof held>>, usual: { ms: number; samples: number } | null, raised: Array<Record<string, unknown>>) =>
    landingTurnAlertSweep({ companies: async () => [companyId], held: heldFn, usual: async () => usual, alert: async (i) => void raised.push(i), now: () => T0 });

  it("stays quiet at the usual wait and at twice it, then names the ticket and what it waits for past twice it", async () => {
    const raised: Array<Record<string, unknown>> = [];
    const usual = { ms: 23 * MIN, samples: 5 };
    expect(await sweep(held(-23), usual, raised).run()).toEqual({ raised: 0 });
    expect(await sweep(held(-46), usual, raised).run()).toEqual({ raised: 0 });
    expect(await sweep(held(-60), null, raised).run()).toEqual({ raised: 0 });
    expect(await sweep(held(-47), usual, raised).run()).toEqual({ raised: 1 });
    expect(raised[0]).toMatchObject({ companyId, kind: "landing_turn_late", from: "ceo", dedupeKey: landingTurnAlertKey(companyId, "t1"), clearWhen: [{ kind: "landingTurnEnded", companyId, ticketId: "t1" }] });
    expect(String(raised[0]!.question)).toContain("BOS-2337");
    expect(String(raised[0]!.question)).toContain("47 minutes");
    expect(String(raised[0]!.question)).toContain("its GitHub run (started 14:52 UTC)");
  });

  it("stops at the CEO and never reaches the owner", () => {
    expect(kindCeiling("landing_turn_late", "ceo")).toBe("ceo");
    expect(kindCeiling("landing_turn_late", undefined)).toBe("ceo");
  });

  it("through the real ladder: one CEO-tier card, kept out of the owner's queue, closed by itself when the ticket's turn ends", async () => {
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
    try {
      const usual = { ms: 23 * MIN, samples: 5 };
      const real = landingTurnAlertSweep({ companies: async () => [companyId], held: held(-60), usual: async () => usual, alert: (i) => built.alerts.raise(i as unknown as Parameters<typeof built.alerts.raise>[0]), now: () => T0 });
      await real.run();
      await real.run(); // a second pass folds into the open card
      const cards = await db.select().from(decisions).where(eq(decisions.dedupeKey, landingTurnAlertKey(companyId, "t1")));
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ tier: "ceo", status: "open" });
      expect((cards[0]!.context as { clearWhen: unknown[] }).clearWhen).toEqual([{ kind: "landingTurnEnded", companyId, ticketId: "t1" }]);
      expect(await db.select().from(decisions).where(and(eq(decisions.tier, "owner"), eq(decisions.status, "open")))).toHaveLength(0);
      // Still holding the turn: the closer leaves it open. Turn over: it closes.
      let holds = true;
      const closer = alertClearing(db, { isConnected: () => false, hasRoom: async () => true, landingTurnHeld: async () => holds });
      expect(await closer.check()).toBe(0);
      holds = false;
      expect(await closer.check()).toBe(1);
      expect((await db.select().from(decisions).where(eq(decisions.id, cards[0]!.id)))[0]!.status).not.toBe("open");
    } finally {
      await built.app.close();
    }
  });

  it("reads its condition back from the card, and stays open when the server can't say who holds the turn", () => {
    expect(clearWhenOf({ clearWhen: [{ kind: "landingTurnEnded", companyId, ticketId: "t1" }, { kind: "landingTurnEnded", companyId }] })).toEqual([{ kind: "landingTurnEnded", companyId, ticketId: "t1" }]);
  });
});
