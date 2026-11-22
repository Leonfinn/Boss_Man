// BOS-2058: the one table of update waits (update-waits.ts). Rules every kind must meet, the live count a server update
// waits on (the 20 Nov 10:05 regression: a check worker's quick checks kept it from ever going quiet), the one list the
// screens read, and which wakes pass an update's hold. All rows are made up; no real clocks.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import type { Db } from "../src/db/client.js";
import { checkJobs, checkWorkers, companies, projects, runs, settings, tickets } from "../src/db/schema.js";
import { runnerBusy, runsByCompany, serverWaitChecks } from "../src/services/runner-busy.js";
import { activeWaits, blocksClass, describeWait, drainEndsAt, LANDING_END_MS, landingsThatCount, ruleProblems, runnerHoldWait, serverQuietCounts, WAIT_RULES, type WaitKind, type WaitRule } from "../src/services/update-waits.js";
import { duringUpdate, PASSES_UPDATE_HOLD, WAKE_CLASS } from "../src/services/wake-classes.js";

// 20 Nov 11:44: a merge whose check had passed and which was only waiting for GitHub CI on its merge copy (phase "merging",
// beat kept fresh by the CI poll) held the runner swap until its CI wait ended. Before the fix every such landing counted.
describe("which landings a runner swap waits on (BOS-2058, the 11:44 hold)", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const started = new Map([
    ["ci", now - 6 * 60_000],
    ["pushing", now - 6 * 60_000],
    ["old", now - LANDING_END_MS - 1],
    ["unknown", Number.NaN],
  ]);
  const facts = { ciWaiting: (id: string) => id === "ci", startedMs: (id: string) => started.get(id)!, now };

  it("drops a landing waiting for GitHub CI and one past its own end; keeps a push and a landing of unknown start", () => {
    expect(landingsThatCount(["ci", "pushing", "old", "unknown"], facts)).toEqual(["pushing", "unknown"]);
  });

  it("counts the same landing again once its CI wait is over and it pushes", () => {
    expect(landingsThatCount(["ci"], { ...facts, ciWaiting: () => false })).toEqual(["ci"]);
  });
});

describe("every wait kind meets the rule (a to e)", () => {
  it("has an end, an earlier CEO wake, words, and waits only for what its hold stops from starting", () => {
    const bad = (Object.keys(WAIT_RULES) as WaitKind[]).flatMap((k) => ruleProblems(k));
    expect(bad).toEqual([]);
  });

  it("a rule that waits for what it does not block, has no end, or has no words is refused", () => {
    const ok: WaitRule = WAIT_RULES["server-quiet"];
    expect(ruleProblems("server-quiet", { ...ok, waitsFor: ["quick-check-worker"] })).toEqual([expect.stringMatching(/waits for quick-check-worker but its hold does not stop/)]);
    expect(ruleProblems("server-quiet", { ...ok, endMin: Number.POSITIVE_INFINITY })).toEqual(expect.arrayContaining([expect.stringMatching(/no end of its own/)]));
    expect(ruleProblems("server-quiet", { ...ok, expectedMin: 90 })).toEqual([expect.stringMatching(/not before its end/)]);
    expect(ruleProblems("server-quiet", { ...ok, words: " " })).toEqual([expect.stringMatching(/no words/)]);
  });

  it("the server wait counts what its hold blocks, and a check worker's quick checks are neither", () => {
    expect(blocksClass("server-quiet", "quick-check-worker")).toBe(false);
    expect(serverQuietCounts("quick-check-worker")).toBe(false);
    expect(serverQuietCounts("merge-check")).toBe(true);
    expect(blocksClass("server-quiet", "merge-check")).toBe(true);
  });

  it("describeWait gives since, a CEO time before the end, and the end in words", () => {
    const w = describeWait("server-quiet", "2026-11-20T10:05:00.000Z", "1 merge check is running");
    expect(w).toMatchObject({ kind: "server-quiet", expectedAt: "2026-11-20T10:35:00.000Z", endsAt: "2026-11-20T11:05:00.000Z", atEnd: "go-ahead" });
    expect(w.waitingOn).toBe("the machine to be quiet (merge checks and runs finishing) (1 merge check is running)");
    expect(w.endsWords).toBe("goes ahead at 11:05 UTC at the latest");
  });
});

describe("what a waiting server update counts (serverWaitChecks)", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await openPglite());
  });
  afterEach(async () => close());

  async function seed() {
    const [c] = await db.insert(companies).values({ name: "Co" }).returning();
    const [p] = await db.insert(projects).values({ companyId: c!.id, name: "P" }).returning();
    const [t] = await db.insert(tickets).values({ companyId: c!.id, projectId: p!.id, title: "T" }).returning();
    const [w] = await db.insert(checkWorkers).values({ name: "worker-1", tokenHash: randomUUID() }).returning();
    const job = (state: string, o: { kind?: string; scope?: string; worker?: boolean } = {}) =>
      db.insert(checkJobs).values({ companyId: c!.id, projectId: p!.id, ticketId: t!.id, kind: o.kind ?? "merge", scope: o.scope ?? "full", commit: "abc", tree: randomUUID(), state, workerId: o.worker ? w!.id : null, startedAt: new Date() });
    return { job };
  }

  // 20 Nov 10:05 to 10:50: the update counted every running check, but its hold let the worker start a quick check each time
  // one ended, so "no check running" never came. The quick checks on a worker are not counted now.
  it("does not count a quick check on a check worker (the 10:05 regression)", async () => {
    const { job } = await seed();
    await job("running", { kind: "pre_review", scope: "quick", worker: true });
    expect(await serverWaitChecks(db)).toBe(0);
  });

  it("counts what its hold stops: a merge or full check anywhere, and a quick check on the runner", async () => {
    const { job } = await seed();
    await job("running", { kind: "merge", scope: "full", worker: true });
    await job("running", { kind: "pre_review", scope: "quick", worker: false });
    await job("running", { kind: "pre_review", scope: "full", worker: true });
    await job("queued", { kind: "merge", scope: "full" });
    await job("passed", { kind: "merge", scope: "full" });
    expect(await serverWaitChecks(db)).toBe(3);
  });
});

describe("activeWaits: one list for every screen", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await openPglite());
  });
  afterEach(async () => close());

  it("lists a server wait, the owner's wrap-up for it, a runner drain and a live landing, each with since, words and end", async () => {
    await db.insert(settings).values({ key: "deploy_wait", value: { phase: "waiting", approvedAt: "2026-11-20T10:05:00.000Z", quiet: { why: ["1 merge check is running"] } } });
    await db.insert(settings).values({ key: "maintenance", value: { kind: "update", since: "2026-11-20T10:30:00.000Z", wrapSince: "2026-11-20T10:40:00.000Z", forUpdate: "runner" } });
    const waits = await activeWaits(db, { landingSince: "2026-11-20T10:45:00.000Z", landingNames: ["abc12345"] });
    expect(waits.map((w) => w.kind)).toEqual(["server-quiet", "wrapup", "runner-drain", "runner-landing"]);
    expect(waits[0]).toMatchObject({ forUpdate: "server", since: "2026-11-20T10:05:00.000Z", endsAt: "2026-11-20T11:05:00.000Z" });
    expect(waits[0]!.waitingOn).toContain("1 merge check is running");
    expect(waits[1]!.waitingOn).toContain("for the runner update");
    expect(waits[3]!.waitingOn).toContain("abc12345");
    for (const w of waits) {
      expect(w.waitingOn).not.toBe("");
      expect(Date.parse(w.endsAt)).toBeGreaterThan(Date.parse(w.since));
      expect(Date.parse(w.expectedAt)).toBeLessThan(Date.parse(w.endsAt));
    }
  });

  it("a runner drain shows when it goes ahead: its own 60 min, or later after 'Wait 10 more' or 'Swap as soon as these finish' (step B)", async () => {
    const since = "2026-11-20T10:00:00.000Z";
    await db.insert(settings).values({ key: "maintenance", value: { kind: "update", since, deadline: "2026-11-20T10:30:00.000Z" } });
    expect((await activeWaits(db))[0]).toMatchObject({ kind: "runner-drain", endsAt: "2026-11-20T11:00:00.000Z", atEnd: "go-ahead" });
    expect(drainEndsAt({ since, deadline: "2026-11-20T11:10:00.000Z" }).toISOString()).toBe("2026-11-20T11:10:00.000Z");
    expect(drainEndsAt({ since, deadline: since, swapWhenDone: true, swapWhenDoneAt: "2026-11-20T10:31:00.000Z" }).toISOString()).toBe("2026-11-20T11:31:00.000Z");
    // An unreadable deadline never makes it end sooner or never.
    expect(drainEndsAt({ since, deadline: "not a date" }).toISOString()).toBe("2026-11-20T11:00:00.000Z");
  });

  it("lists nothing when no update waits", async () => {
    expect(await activeWaits(db)).toEqual([]);
  });

  it("a standalone wrap-up says so and that it lifts by itself", async () => {
    await db.insert(settings).values({ key: "maintenance", value: { kind: "wrapup", since: "2026-11-20T10:00:00.000Z", wrapSince: "2026-11-20T10:00:00.000Z", forUpdate: "none" } });
    const [w] = await activeWaits(db);
    expect(w).toMatchObject({ kind: "wrapup", endsAt: "2026-11-20T11:00:00.000Z" });
    expect(w!.waitingOn).toContain("no update is waiting, so it lifts by itself");
  });
});

describe("wakes that report on an update pass its hold", () => {
  it("only listed reasons pass, and each is a real wake reason", () => {
    expect(PASSES_UPDATE_HOLD.length).toBeGreaterThan(0);
    for (const r of PASSES_UPDATE_HOLD) expect(r in WAKE_CLASS).toBe(true);
    expect(duringUpdate("update alert")).toBe("passes");
    // The generic reply lane stays held once nothing else runs (DR-048 A, ceo-reply-lane.test.ts).
    expect(duringUpdate("ceo reply")).toBe("held");
    expect(duringUpdate("checking an old card")).toBe("held");
    expect(duringUpdate("nudge")).toBe("held");
  });
});

// BOS-2088: a wake about an urgent ticket, or one that fixes a live problem, waited behind the update it may be the fix for.
describe("wakes about an urgent or fixes-live ticket pass an update's hold (BOS-2088)", () => {
  const open = { urgent: false, fixesLive: null, systemState: "in_progress", mergeCommit: null };
  it("passes for an open, unmerged urgent or fixes-live ticket, whatever the reason", () => {
    expect(duringUpdate("nudge", { ...open, urgent: true })).toBe("passes");
    expect(duringUpdate("resume", { ...open, fixesLive: "server freezes as memory climbs" })).toBe("passes");
    expect(duringUpdate("assigned", { ...open, urgent: true, systemState: "review" })).toBe("passes");
  });
  it("holds a plain ticket, a blank fixesLive, a merged or done one, and a wake with no ticket", () => {
    expect(duringUpdate("nudge", open)).toBe("held");
    expect(duringUpdate("nudge", { ...open, fixesLive: "  " })).toBe("held");
    expect(duringUpdate("live release", { ...open, fixesLive: "server freezes", mergeCommit: "a".repeat(40) })).toBe("held");
    expect(duringUpdate("ticket watch", { ...open, urgent: true, systemState: "done" })).toBe("held");
    expect(duringUpdate("nudge", null)).toBe("held");
    expect(duringUpdate("nudge")).toBe("held");
  });
});

describe("what an update counts as running work (runner-busy.ts updateWaitCountsRun, BOS-2088)", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await openPglite());
  });
  afterEach(async () => close());

  it("leaves out chat, the reply lane and a run that passed the hold; counts plain work", async () => {
    const [c] = await db.insert(companies).values({ name: "Co" }).returning();
    const run = (o: { purpose?: string | null; passed?: boolean }) => db.insert(runs).values({ companyId: c!.id, purpose: o.purpose ?? null, passedUpdateHold: o.passed ?? false, startedAt: new Date() });
    await run({});
    await run({ purpose: "chat" });
    await run({ purpose: "reply" });
    await run({ passed: true });
    expect(await runsByCompany(db, true)).toEqual(new Map([[c!.id, 1]]));
    expect(await runsByCompany(db, false)).toEqual(new Map([[c!.id, 4]]));
    expect((await runnerBusy(db, true)).runsTotal).toBe(1);
  });
});

describe("runnerHoldWait: the wait a runner hold is (BOS-2108)", () => {
  it("is the plain drain when the owner did not force it", () => {
    expect(runnerHoldWait({})).toBe("runner-drain");
    expect(runnerHoldWait({ force: false, ignoreChecks: false })).toBe("runner-drain");
  });

  it("is the owner's stop-and-update choice when force or ignoreChecks is set", () => {
    expect(runnerHoldWait({ force: true })).toBe("owner-force");
    expect(runnerHoldWait({ ignoreChecks: true })).toBe("owner-force");
    expect(runnerHoldWait({ force: true, ignoreChecks: true })).toBe("owner-force");
  });
});
