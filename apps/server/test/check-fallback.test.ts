import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { CHECK_QUEUE_MODE_KEY, checkQueue } from "../src/services/check-queue.js";
import { CARRY_ON_NOTE } from "../src/services/check-wording.js";
import { checkRequestService } from "../src/services/check-request.js";
import { workService } from "../src/services/work.js";

// BOS-1412: while an agent's own check is queued or running, one fallback is enough. A second schedule_check
// on the ticket is refused in plain words, so agents don't book a chain of empty runs that only re-read the queue.
const shared = openPglite();
afterAll(async () => (await shared).close());

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  await db.insert(runners).values({ companyId: co!.id, name: "r", tokenHash: `h${Math.random()}` } as never);
  const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude" } as never).returning();
  const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: 1, assigneeAgentId: a!.id, systemState: "in_progress" } as never).returning();
  const work = workService(db);
  const queue = checkQueue(db);
  const request = checkRequestService(db, { diff: async () => ({ baseCommit: "b", head: "headcommit1", tree: "tree1", commits: [{ sha: "headcommit1", subject: "x" }], files: [], diff: "", truncated: false }) });
  const book = (inMinutes: number, note = "waiting on the check") => work.setMonitor(t!.id, { at: new Date(Date.now() + inMinutes * 60_000), note, by: { agentId: a!.id, companyId: co!.id } });
  const live = async (commit = "headcommit1", tree = "tree1", kind: "pre_review" | "merge" = "pre_review") =>
    (await queue.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: t!.id, kind, scope: kind === "merge" ? "full" : "quick", commit, tree, command: kind === "merge" ? null : "scripts/check-quick.sh", requestedBy: a!.id })).job;
  return { db, co: co!.id, agent: a!.id, ticket: t!.id, work, queue, request, book, live };
}

describe("schedule_check while the agent's own check is live (BOS-1412)", () => {
  it("allows one fallback, then refuses a second with the place, the wake and the booking time", async () => {
    const s = await setup();
    const job = await s.live();
    await s.queue.enqueue({ companyId: s.co, projectId: (await s.db.select().from(tickets))[0]!.projectId, ticketId: (await s.db.insert(tickets).values({ companyId: s.co, projectId: (await s.db.select().from(tickets))[0]!.projectId, title: "Ahead", number: 2 } as never).returning())[0]!.id, kind: "pre_review", scope: "quick", commit: "c".repeat(40), tree: "t".repeat(40), command: "scripts/check-quick.sh" });
    const first = await s.book(30);
    expect(first.monitorAt).not.toBeNull();
    const place = (await s.queue.status(s.co)).queued.find((q) => q.id === job.id)!.place;
    const err = await s.book(60, "another look").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`Your check for ${job.commit.slice(0, 8)} is queued at no. ${place}; its result will wake you. You already have a fallback booked for ${first.monitorAt!.toISOString().slice(11, 16)}.`);
    // The existing booking was left as it was: a refused second never moves it.
    expect((await s.db.select().from(tickets).where(eq(tickets.id, s.ticket)))[0]!.monitorAt).toEqual(first.monitorAt);
  });

  it("re-booking the same wake time is a rewrite, not a second fallback", async () => {
    const s = await setup();
    await s.live();
    const at = new Date(Date.now() + 30 * 60_000);
    await s.work.setMonitor(s.ticket, { at, note: "first", by: { agentId: s.agent, companyId: s.co } });
    const again = await s.work.setMonitor(s.ticket, { at, note: "rewritten", by: { agentId: s.agent, companyId: s.co } });
    expect(again).toMatchObject({ monitorNote: "rewritten" });
  });

  it("lets the agent book freely once its check has ended", async () => {
    const s = await setup();
    const job = await s.live();
    await s.book(30);
    await s.queue.cancel(job.id, "test");
    expect((await s.book(60, "after the check")).monitorAt).not.toBeNull();
  });

  it("leaves merge checks and tickets with no live job alone", async () => {
    const s = await setup();
    // No job at all: as many bookings as before.
    await s.book(20);
    expect((await s.book(40, "second")).monitorAt).not.toBeNull();
    // A merge check is the gate's, not the agent's own request: it never blocks a booking.
    await s.db.update(tickets).set({ monitorAt: null }).where(eq(tickets.id, s.ticket));
    await s.live("m".repeat(40), "r".repeat(40), "merge");
    expect((await s.book(30, "during the merge check")).monitorAt).not.toBeNull();
  });

  it("Boss Man's own carry-on wake does not count as the agent's fallback", async () => {
    const s = await setup();
    await s.live();
    await s.db.update(tickets).set({ monitorAt: new Date(Date.now() + 15 * 60_000), monitorNote: CARRY_ON_NOTE }).where(eq(tickets.id, s.ticket));
    expect((await s.book(30, "my own")).monitorAt).not.toBeNull();
  });

  it("request_check hands back the waiting job, keeps its place, and a different tree still supersedes", async () => {
    const s = await setup();
    const { db } = await shared;
    const first = await s.request.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(first).toMatch(/is queued/);
    const [job] = await db.select().from(checkJobs).where(eq(checkJobs.ticketId, s.ticket));
    const started = job!.queuedAt;
    const again = await s.request.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(again).toMatch(/already (queued at no\. |running now)/);
    const same = (await db.select().from(checkJobs).where(eq(checkJobs.ticketId, s.ticket))).filter((j) => j.state === "queued");
    expect(same).toHaveLength(1);
    expect(same[0]!.queuedAt.getTime()).toBe(started.getTime());
  });
});
