import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { activity, checkJobs, companies, projects, settings, tickets } from "../src/db/schema.js";
import { checkQueue } from "../src/services/check-queue.js";

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
});
