import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { activity, checkJobs, companies, projects, settings, tickets } from "../src/db/schema.js";
import { checkQueue } from "../src/services/check-queue.js";
import { landingTurns } from "../src/services/landing-turn.js";

// BOS-1384: urgent merges go ahead of ordinary ones (read live from the ticket), and "Move to front" puts a merge next.
const shared = openPglite();
afterAll(async () => (await shared).close());

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  let n = 0;
  const q = checkQueue(db);
  const merge = async (opts: { urgent?: boolean; fixesMain?: boolean; minutesAgo: number }) => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `T${n}`, number: n, urgent: opts.urgent ?? false }).returning();
    // Stored priority is always "normal": urgency must come from the ticket as it is now.
    const { job } = await q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: `c${n}`, tree: `t${n}`, fixesMain: opts.fixesMain, priority: 1 });
    await db.update(checkJobs).set({ queuedAt: new Date(Date.now() - opts.minutesAgo * 60_000) }).where(eq(checkJobs.id, job.id));
    return { ticketId: t!.id, jobId: job.id };
  };
  const order = async () => (await q.list(co!.id)).rows.filter((r) => r.state === "waiting").map((r) => r.ticketId);
  return { db, q, co: co!, merge, order };
}

describe("merge line order (BOS-1384)", () => {
  it("serves a fix for main, then moved-to-front, then urgent, then oldest", async () => {
    const s = await setup();
    const old = await s.merge({ minutesAgo: 50 });
    const newer = await s.merge({ minutesAgo: 10 });
    const urgent = await s.merge({ minutesAgo: 5, urgent: true });
    const fix = await s.merge({ minutesAgo: 1, fixesMain: true });
    expect(await s.order()).toEqual([fix.ticketId, urgent.ticketId, old.ticketId, newer.ticketId]);
    expect(await s.q.moveToFront(s.co.id, newer.ticketId, "Sam", "needed now")).not.toBeNull();
    expect(await s.order()).toEqual([fix.ticketId, newer.ticketId, urgent.ticketId, old.ticketId]);
    // The latest move is next in line.
    await s.q.moveToFront(s.co.id, old.ticketId, "Sam");
    expect((await s.order())[1]).toBe(old.ticketId);
    const rows = (await s.q.list(s.co.id)).rows;
    expect(rows.find((r) => r.ticketId === old.ticketId)!.why).toBe("moved to front by Sam");
    expect(rows.find((r) => r.ticketId === urgent.ticketId)!.why).toBe("urgent");
    expect(rows.find((r) => r.ticketId === fix.ticketId)!.why).toBe("fixes main");
    // The move is in the activity log with who.
    const log = await s.db.select().from(activity).where(eq(activity.ticketId, old.ticketId));
    expect(log.some((a) => a.summary.includes("Sam moved this merge to the front"))).toBe(true);
  });

  it("marking a waiting ticket urgent moves it up at once; clearing it puts it back by join time", async () => {
    const s = await setup();
    const a = await s.merge({ minutesAgo: 40 });
    const b = await s.merge({ minutesAgo: 20 });
    expect(await s.order()).toEqual([a.ticketId, b.ticketId]);
    await s.db.update(tickets).set({ urgent: true }).where(eq(tickets.id, b.ticketId));
    expect(await s.order()).toEqual([b.ticketId, a.ticketId]);
    await s.db.update(tickets).set({ urgent: false }).where(eq(tickets.id, b.ticketId));
    expect(await s.order()).toEqual([a.ticketId, b.ticketId]);
  });

  it("never moves a merge that is already running, and a moved merge keeps its move when re-queued", async () => {
    const s = await setup();
    const a = await s.merge({ minutesAgo: 30 });
    const b = await s.merge({ minutesAgo: 20 });
    const [run] = await s.q.claimNext(null);
    expect(run!.ticketId).toBe(a.ticketId);
    expect(await s.q.moveToFront(s.co.id, a.ticketId, "Sam")).toBeNull();
    expect(await s.q.moveToFront(s.co.id, b.ticketId, "Sam")).not.toBeNull();
    // Main moved: the same ticket asks again on a new tree and keeps both its place and its move.
    const again = (await s.q.enqueue({ companyId: s.co.id, projectId: (await s.db.select().from(tickets).where(eq(tickets.id, b.ticketId)))[0]!.projectId, ticketId: b.ticketId, kind: "merge", scope: "full", commit: "c-new", tree: "t-new" })).job;
    expect(again.frontBy).toBe("Sam");
    expect(again.frontAt).not.toBeNull();
  });

  // BOS-1822: every other passed merge of the project waits to push while a ticket holds the landing turn (BOS-1762), so the
  // holder's re-check must start next, not wait at its ordinary tier and place behind older, urgent or moved-to-front jobs.
  it("serves the landing-turn holder's re-check first, below only a fix for main", async () => {
    const s = await setup();
    const old = await s.merge({ minutesAgo: 50 });
    const urgent = await s.merge({ minutesAgo: 40, urgent: true });
    const moved = await s.merge({ minutesAgo: 30 });
    await s.q.moveToFront(s.co.id, moved.ticketId, "Sam");
    const holder = await s.merge({ minutesAgo: 1 });
    const [h] = await s.db.select().from(tickets).where(eq(tickets.id, holder.ticketId));
    const projectId = h!.projectId;
    try {
      // Two rebuilds after a pass take the turn (capMs 25 minutes).
      landingTurns.rebuilt(projectId, holder.ticketId, 25 * 60_000);
      expect(landingTurns.rebuilt(projectId, holder.ticketId, 25 * 60_000).turn).toBe("taken");
      expect(await s.order()).toEqual([holder.ticketId, moved.ticketId, urgent.ticketId, old.ticketId]);
      expect((await s.q.list(s.co.id)).rows.find((r) => r.ticketId === holder.ticketId)!.why).toBe("holds the landing turn");
      // A fix for a red main still goes first.
      const fix = await s.merge({ minutesAgo: 0, fixesMain: true });
      expect((await s.order()).slice(0, 2)).toEqual([fix.ticketId, holder.ticketId]);
      // The free slot goes to the fix, the next one to the holder, not to the older jobs.
      expect((await s.q.claimNext(null)).map((j) => j.ticketId)).toEqual([fix.ticketId]);
      await s.db.update(checkJobs).set({ state: "passed", endedAt: new Date() }).where(eq(checkJobs.id, fix.jobId));
      expect((await s.q.claimNext(null)).map((j) => j.ticketId)).toEqual([holder.ticketId]);
    } finally {
      landingTurns.done(projectId, holder.ticketId);
    }
    // The turn over, the others keep their usual order.
    expect(await s.order()).toEqual([moved.ticketId, urgent.ticketId, old.ticketId]);
  });
});

// BOS-1519: an urgent or moved-to-front quick check ranks with the aged quick checks (DR-056's "with the merges" group) from
// the moment it is queued, and Move to front works on quick checks too.
describe("urgent and moved-to-front quick checks (BOS-1519)", () => {
  async function quick(s: Awaited<ReturnType<typeof setup>>, opts: { urgent?: boolean; minutesAgo: number; scope?: "quick" | "full" }) {
    const [p] = await s.db.select().from(projects).where(eq(projects.companyId, s.co.id));
    const n = Math.floor(Math.random() * 1e9);
    const [t] = await s.db.insert(tickets).values({ companyId: s.co.id, projectId: p!.id, title: `Q${n}`, number: n, urgent: opts.urgent ?? false }).returning();
    const { job } = await s.q.enqueue({ companyId: s.co.id, projectId: p!.id, ticketId: t!.id, kind: "pre_review", scope: opts.scope ?? "quick", commit: `q${n}`, tree: `qt${n}`, priority: 1 });
    await s.db.update(checkJobs).set({ queuedAt: new Date(Date.now() - opts.minutesAgo * 60_000) }).where(eq(checkJobs.id, job.id));
    return { ticketId: t!.id, jobId: job.id };
  }

  it("an urgent quick check queued just now sorts ahead of older aged quick checks and ordinary merges", async () => {
    const s = await setup();
    const aged1 = await quick(s, { minutesAgo: 40 });
    const aged2 = await quick(s, { minutesAgo: 20 });
    const merge = await s.merge({ minutesAgo: 30 });
    const fresh = await quick(s, { minutesAgo: 1 });
    const urgent = await quick(s, { minutesAgo: 0, urgent: true });
    // Urgent joins the with-merges group at once and is top tier there; the fresh ordinary one keeps DR-056's place, last.
    expect(await s.order()).toEqual([urgent.ticketId, aged1.ticketId, merge.ticketId, aged2.ticketId, fresh.ticketId]);
    // Clearing urgency puts it back below the aged group until it ages itself (it was queued after `fresh`).
    await s.db.update(tickets).set({ urgent: false }).where(eq(tickets.id, urgent.ticketId));
    expect(await s.order()).toEqual([aged1.ticketId, merge.ticketId, aged2.ticketId, fresh.ticketId, urgent.ticketId]);
  });

  it("ordinary quick checks keep DR-056's order: fresh ones wait below the aged ones", async () => {
    const s = await setup();
    const fresh = await quick(s, { minutesAgo: 2 });
    const aged = await quick(s, { minutesAgo: 15 });
    const merge = await s.merge({ minutesAgo: 12 });
    expect(await s.order()).toEqual([aged.ticketId, merge.ticketId, fresh.ticketId]);
  });

  it("Move to front puts a queued quick check next, and logs it as a quick check", async () => {
    const s = await setup();
    const aged = await quick(s, { minutesAgo: 30 });
    const merge = await s.merge({ minutesAgo: 25 });
    const fresh = await quick(s, { minutesAgo: 1 });
    expect(await s.order()).toEqual([aged.ticketId, merge.ticketId, fresh.ticketId]);
    const moved = await s.q.moveToFront(s.co.id, fresh.ticketId, "Sam", "needed now");
    expect(moved?.id).toBe(fresh.jobId);
    expect(await s.order()).toEqual([fresh.ticketId, aged.ticketId, merge.ticketId]);
    const rows = (await s.q.list(s.co.id)).rows;
    expect(rows.find((r) => r.ticketId === fresh.ticketId)!.why).toBe("moved to front by Sam");
    const log = await s.db.select().from(activity).where(eq(activity.ticketId, fresh.ticketId));
    expect(log.some((a) => a.summary === "Sam moved this quick check to the front of the line: needed now")).toBe(true);
    // It is claimed first.
    const [run] = await s.q.claimNext(null);
    expect(run!.id).toBe(fresh.jobId);
  });

  it("Move to front leaves a full pre-review check and a running quick check alone", async () => {
    const s = await setup();
    const full = await quick(s, { minutesAgo: 5, scope: "full" });
    expect(await s.q.moveToFront(s.co.id, full.ticketId, "Sam")).toBeNull();
    await s.db.delete(checkJobs);
    const q1 = await quick(s, { minutesAgo: 5 });
    const [run] = await s.q.claimNext(null);
    expect(run!.id).toBe(q1.jobId);
    expect(await s.q.moveToFront(s.co.id, q1.ticketId, "Sam")).toBeNull();
  });

  // BOS-2105: a full pre-review check (request_check scope full) was never in the with-merges group, so it waited behind every
  // merge and aged quick check however long it had waited, and urgency did nothing. It now ages and ranks like a quick check.
  it("a full pre-review check ages into the merge line, and an urgent one joins it at once", async () => {
    const s = await setup();
    const merge = await s.merge({ minutesAgo: 20 });
    const agedQuick = await quick(s, { minutesAgo: 15 });
    const full = await quick(s, { minutesAgo: 30, scope: "full" });
    const fresh = await quick(s, { minutesAgo: 1 });
    // Waited 30 minutes: it sorts by queue time with the merges, ahead of the newer merge and aged quick check.
    expect(await s.order()).toEqual([full.ticketId, merge.ticketId, agedQuick.ticketId, fresh.ticketId]);
    // Queued just now and not urgent: it waits below the aged group, as a fresh quick check does.
    await s.db.update(checkJobs).set({ queuedAt: new Date(Date.now() - 60_000) }).where(eq(checkJobs.id, full.jobId));
    expect((await s.order()).slice(0, 2)).toEqual([merge.ticketId, agedQuick.ticketId]);
    // Urgent: top tier in the with-merges group from the moment it is queued.
    await s.db.update(tickets).set({ urgent: true }).where(eq(tickets.id, full.ticketId));
    expect(await s.order()).toEqual([full.ticketId, merge.ticketId, agedQuick.ticketId, fresh.ticketId]);
  });
});
