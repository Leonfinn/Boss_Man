import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, settings, tickets } from "../src/db/schema.js";
import { checkQueue, isGateRerun } from "../src/services/check-queue.js";
import { gateRerunCommand } from "../src/services/ci-flake.js";
import { checkPriority, isBackgroundLaneTitle, laneWords } from "../src/services/check-gate.js";

// BOS-1403: a background-lane ticket (its assignee's job title is Background Developer) merges after the ordinary ones.
const shared = openPglite();
afterAll(async () => (await shared).close());

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const mk = async (name: string, title: string) => (await db.insert(agents).values({ companyId: co!.id, name, role: "worker", agentKind: "claude", title }).returning())[0]!.id;
  const lane = await mk("Lane", "Background Developer");
  const dev = await mk("Dev", "Developer");
  let n = 0;
  const q = checkQueue(db);
  const merge = async (opts: { lane?: boolean; urgent?: boolean; fixesMain?: boolean; minutesAgo: number; kind?: "merge" | "pre_review"; scope?: "quick" | "full"; command?: string; priority?: number }) => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `T${n}`, number: n, urgent: opts.urgent ?? false, assigneeAgentId: opts.lane ? lane : dev }).returning();
    const { job } = await q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: t!.id, kind: opts.kind ?? "merge", scope: opts.scope ?? "full", commit: `c${n}`, tree: `t${n}`, fixesMain: opts.fixesMain, priority: opts.priority ?? 1, command: opts.command });
    await db.update(checkJobs).set({ queuedAt: new Date(Date.now() - opts.minutesAgo * 60_000) }).where(eq(checkJobs.id, job.id));
    return t!.id;
  };
  const order = async () => (await q.list(co!.id)).rows.filter((r) => r.state === "waiting").map((r) => r.ticketId);
  return { q, co: co!, merge, order };
}

describe("merge line: background lane goes last (BOS-1403)", () => {
  it("priorities: broken-main/urgent 0, ordinary 1, lane 2", () => {
    expect(checkPriority({ urgent: true, background: true })).toBe(0);
    expect(checkPriority({ title: "Arch fix 3: x", background: true })).toBe(0);
    expect(checkPriority({ title: "Add a button" })).toBe(1);
    expect(checkPriority({ title: "Tests for x (Background lane)", background: true })).toBe(2);
    expect(isBackgroundLaneTitle("Background Developer")).toBe(true);
    expect(isBackgroundLaneTitle("Senior Developer")).toBe(false);
    expect(isBackgroundLaneTitle(null)).toBe(false);
  });

  it("a lane ticket that joined first waits behind a later ordinary one", async () => {
    const s = await setup();
    const lane = await s.merge({ lane: true, minutesAgo: 50 });
    const normal = await s.merge({ minutesAgo: 5 });
    expect(await s.order()).toEqual([normal, lane]);
  });

  it("a lane ticket alone starts at once", async () => {
    const s = await setup();
    const lane = await s.merge({ lane: true, minutesAgo: 1 });
    const [run] = await s.q.claimNext(null);
    expect(run!.ticketId).toBe(lane);
  });

  it("Move to front on a lane ticket puts it first; urgent and broken-main order is unchanged", async () => {
    const s = await setup();
    const normal = await s.merge({ minutesAgo: 40 });
    const lane = await s.merge({ lane: true, minutesAgo: 30 });
    const urgent = await s.merge({ urgent: true, minutesAgo: 20 });
    const fix = await s.merge({ lane: true, fixesMain: true, minutesAgo: 1 });
    expect(await s.order()).toEqual([fix, urgent, normal, lane]);
    await s.q.moveToFront(s.co.id, lane, "Sam");
    expect(await s.order()).toEqual([fix, lane, urgent, normal]);
  });
});

// BOS-1803: on 18 Nov a lane merge queued at 04:45 still waited at 12:55 behind ordinary merges queued hours later.
describe("merge line: a background-lane merge ages up (BOS-1803)", () => {
  it("after the default 2 h it ranks as ordinary by its queue time; urgent work still goes first", async () => {
    const s = await setup();
    const older = await s.merge({ minutesAgo: 240 });
    const lane = await s.merge({ lane: true, minutesAgo: 480 - 5 }); // the 04:45 merge, read at 12:40
    const newer = await s.merge({ minutesAgo: 10 });
    const urgent = await s.merge({ urgent: true, minutesAgo: 1 });
    expect(await s.order()).toEqual([urgent, lane, older, newer]);
    // A restart re-seats the merge train in the same order.
    expect(await s.q.liveMergeOrder(await projectOf(s.co.id))).toEqual([urgent, lane, older, newer]);
  });

  it("still yields to newer ordinary work before the lane age, and the setting moves the line both ways", async () => {
    const s = await setup();
    const lane = await s.merge({ lane: true, minutesAgo: 90 });
    const newer = await s.merge({ minutesAgo: 10 });
    expect(await s.order()).toEqual([newer, lane]);
    await s.q.setLaneAge(60);
    expect(await s.order()).toEqual([lane, newer]);
    await s.q.setLaneAge(0); // off: the BOS-1403 order as before
    expect(await s.order()).toEqual([newer, lane]);
    expect(await s.q.laneAge()).toBe(0);
  });

  it("says the lane and how long it still gives way, on the waiting row only", async () => {
    const s = await setup();
    const lane = await s.merge({ lane: true, minutesAgo: 50 });
    const aged = await s.merge({ lane: true, minutesAgo: 200 });
    const normal = await s.merge({ minutesAgo: 5 });
    const rows = new Map((await s.q.list(s.co.id)).rows.map((r) => [r.ticketId, r]));
    expect(rows.get(lane)!.lane).toBe("background lane: newer ordinary work goes first for up to 1 h 10 min more");
    expect(rows.get(aged)!.lane).toBe("background lane, waited over 2 h, so now in line by when it joined");
    expect(rows.get(normal)!.lane).toBeNull();
    await s.q.moveToFront(s.co.id, lane, "Sam");
    expect((await s.q.list(s.co.id)).rows.find((r) => r.ticketId === lane)!.lane).toBeNull(); // moved to front: no lane to explain
  });

  it("the setting takes whole minutes from 0 to a day; anything stored oddly reads as the default", async () => {
    const s = await setup();
    for (const bad of [-1, 1441, 1.5]) await expect(s.q.setLaneAge(bad)).rejects.toThrow(/whole number of minutes/);
    expect(await s.q.laneAge()).toBe(120);
    const { db } = await shared;
    await db.insert(settings).values({ key: "background_lane_age_minutes", value: "soon" });
    expect(await s.q.laneAge()).toBe(120);
    expect(laneWords(1, 0, 0)).toBeNull();
    expect(laneWords(2, 0, 0)).toBe("background lane: newer ordinary work goes first");
  });
});

// BOS-2453: on 24 Nov BOS-2365 (background lane) had GitHub CI fail by chance; the gate's re-run of the failed test file was
// queued at the ticket's tier 2, waited 45 minutes without starting, hit its time limit and sent the ticket back.
describe("merge line: the gate's flake re-run starts at the front (BOS-2453)", () => {
  const rerun = gateRerunCommand(["apps/web/test/chat-find.test.tsx"]);

  it("a background-lane ticket's re-run goes ahead of waiting background, ordinary and quick checks; a fix for main still goes first", async () => {
    const s = await setup();
    const normal = await s.merge({ minutesAgo: 40 });
    const lane = await s.merge({ lane: true, minutesAgo: 30 });
    const quick = await s.merge({ kind: "pre_review", scope: "quick", minutesAgo: 60 });
    const laneQuick = await s.merge({ lane: true, kind: "pre_review", scope: "quick", minutesAgo: 50 });
    // Queued last, at the lane ticket's own tier, the way flakeRetry passes `priority: checkPrio`.
    const flaky = await s.merge({ lane: true, scope: "quick", command: rerun, priority: 2, minutesAgo: 0 });
    expect((await s.order())[0]).toBe(flaky);
    expect(new Set((await s.order()).slice(1))).toEqual(new Set([normal, lane, quick, laneQuick]));
    const row = (await s.q.list(s.co.id)).rows.find((r) => r.ticketId === flaky)!;
    expect(row.why).toBe("re-runs the tests GitHub failed, for a merge under way");
    expect(row.lane).toBeNull();
    const [run] = await s.q.claimNext(null);
    expect(run!.ticketId).toBe(flaky);
  });

  it("never jumps a fix for a broken main", async () => {
    const s = await setup();
    const flaky = await s.merge({ lane: true, scope: "quick", command: rerun, priority: 2, minutesAgo: 10 });
    const fix = await s.merge({ lane: true, fixesMain: true, minutesAgo: 0 });
    expect(await s.order()).toEqual([fix, flaky]);
  });

  it("only the gate's own re-run command counts, not any merge job", () => {
    expect(isGateRerun({ kind: "merge", command: rerun })).toBe(true);
    expect(isGateRerun({ kind: "pre_review", command: rerun })).toBe(false);
    expect(isGateRerun({ kind: "merge", command: "pnpm test" })).toBe(false);
    expect(isGateRerun({ kind: "merge", command: null })).toBe(false);
  });
});

async function projectOf(companyId: string): Promise<string> {
  const { db } = await shared;
  return (await db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, companyId)))[0]!.id;
}
