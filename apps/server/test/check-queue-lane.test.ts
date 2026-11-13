import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, settings, tickets } from "../src/db/schema.js";
import { checkQueue } from "../src/services/check-queue.js";
import { checkPriority, isBackgroundLaneTitle } from "../src/services/check-gate.js";

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
  const merge = async (opts: { lane?: boolean; urgent?: boolean; fixesMain?: boolean; minutesAgo: number }) => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `T${n}`, number: n, urgent: opts.urgent ?? false, assigneeAgentId: opts.lane ? lane : dev }).returning();
    const { job } = await q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: `c${n}`, tree: `t${n}`, fixesMain: opts.fixesMain, priority: 1 });
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
