// BOS-2058: the one table of update waits (update-waits.ts). Rules every kind must meet, the live count a server update
// waits on (the 20 Nov 10:05 regression: a check worker's quick checks kept it from ever going quiet), the one list the
// screens read, and which wakes pass an update's hold. All rows are made up; no real clocks.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import type { Db } from "../src/db/client.js";
import { checkJobs, checkWorkers, companies, projects, runs, settings, tickets } from "../src/db/schema.js";
import { runnerBusy, runsByCompany, serverWaitChecks, workerChecks } from "../src/services/runner-busy.js";
import { activeWaits, blocksClass, describeWait, drainDetail, drainEndsAt, LANDING_END_MS, landingsThatCount, namedChecksText, ruleProblems, runnerHoldWait, serverQuietCounts, WAIT_RULES, type WaitKind, type WaitRule } from "../src/services/update-waits.js";
import { duringUpdate, PASSES_UPDATE_HOLD, WAKE_CLASS } from "../src/services/wake-classes.js";

// BOS-2479 (replacing BOS-2058's exception list): a landing counts only while its push call is going, for at most
// LANDING_END_MS from that call's start. A landing waiting for GitHub CI (20 Nov 11:44), a train seat (24 Nov 10:11) or
// anything else before the push has no push start, so it never counts.
describe("which landings a runner swap waits on (BOS-2479: only a push under way)", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const pushStarts = new Map([
    ["pushing", now - 6 * 60_000],
    ["old", now - LANDING_END_MS - 1],
  ]);
  const facts = { pushingSince: (id: string) => pushStarts.get(id), now };

  it("keeps a push under way; drops a landing that isn't pushing and a push past its own end", () => {
    expect(landingsThatCount(["ci-wait", "train-seat", "pushing", "old"], facts)).toEqual(["pushing"]);
  });

  it("counts the same landing once its push starts", () => {
    expect(landingsThatCount(["train-seat"], facts)).toEqual([]);
    expect(landingsThatCount(["train-seat"], { ...facts, pushingSince: () => now })).toEqual(["train-seat"]);
  });
});

// BOS-2479: on 24 Nov the drain line always read "running agents and checks to finish", with no counts, while two quick
// checks ran on a check worker that the drain never waits for; the CEO read them as what held the update.
describe("the drain line says what it still waits on, and what it does not (BOS-2479)", () => {
  const quick = (ticket: string) => ({ ticket, kind: "pre_review", scope: "quick" });
  it("names its runs and runner checks with counts and tickets", () => {
    expect(drainDetail({ runs: 3, runnerChecks: [quick("BOS-2456"), quick("BOS-2468"), { ticket: "BOS-2408", kind: "merge", scope: "full" }], workerChecks: [] }, false)).toBe("3 agent runs; 2 quick checks: BOS-2456, BOS-2468; 1 merge check: BOS-2408");
  });
  it("says plainly when nothing of its own is left, and names worker checks as not waited for", () => {
    expect(drainDetail({ runs: 0, runnerChecks: [], workerChecks: [quick("BOS-2456"), quick("BOS-2468")] }, true)).toBe(
      "nothing left of its own; it now waits only for the waits below. Not waited for: 2 quick checks: BOS-2456, BOS-2468 on a check worker",
    );
    expect(drainDetail({ runs: 0, runnerChecks: [], workerChecks: [] }, false)).toBe("nothing left; the swap happens on the next pass");
    expect(namedChecksText([{ ticket: null, kind: "pre_review", scope: "full" }])).toBe("1 full check: no ticket");
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

  // BOS-2479: the runner drain's "not waited for" list is exactly the running checks on a worker.
  it("workerChecks lists running checks on a check worker only, by ticket reference", async () => {
    const { job } = await seed();
    await job("running", { kind: "pre_review", scope: "quick", worker: true });
    await job("running", { kind: "pre_review", scope: "quick", worker: false });
    await job("queued", { kind: "pre_review", scope: "quick", worker: true });
    const rows = await workerChecks(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "pre_review", scope: "quick", ticket: "T-1" });
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

  it("BOS-2479: the drain row carries its counts and the landing row names tickets by reference", async () => {
    await db.insert(settings).values({ key: "maintenance", value: { kind: "update", since: "2026-11-24T10:05:00.000Z", deadline: "2026-11-24T10:35:00.000Z" } });
    const quick = (ticket: string) => ({ ticket, kind: "pre_review", scope: "quick" });
    const waits = await activeWaits(db, { landingSince: "2026-11-24T10:20:00.000Z", landingNames: ["BOS-2408"], drain: { runs: 0, runnerChecks: [quick("BOS-2456"), quick("BOS-2468")], workerChecks: [quick("BOS-2470")] } });
    expect(waits.map((w) => w.waitingOn)).toEqual([
      "running agents and checks to finish (2 quick checks: BOS-2456, BOS-2468. Not waited for: 1 quick check: BOS-2470 on a check worker)",
      "a merge that is being pushed to main (BOS-2408)",
    ]);
    // Without a landing, an empty drain says the swap is next; with the owner's force, no counts (it waits for none).
    expect((await activeWaits(db, { drain: { runs: 0, runnerChecks: [], workerChecks: [] } }))[0]!.waitingOn).toContain("nothing left; the swap happens on the next pass");
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
