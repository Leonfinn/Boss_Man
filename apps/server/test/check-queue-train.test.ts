import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, settings, tickets } from "../src/db/schema.js";
import { checkQueue } from "../src/services/check-queue.js";
import { resetTrains, trainFor } from "../src/services/merge-train.js";

// BOS-1504: with the merge train on, the check queue follows the train. Seated members are served in seat order, ahead of the
// background lane; a ticket still waiting for a seat doesn't take a slot; the restart seed orders by tier like admission does.
const shared = openPglite();
afterAll(async () => (await shared).close());
beforeEach(() => resetTrains());

async function setup(opts: { train?: boolean; slots?: number } = {}) {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const mk = async (name: string, title: string) => (await db.insert(agents).values({ companyId: co!.id, name, role: "worker", agentKind: "claude", title }).returning())[0]!.id;
  const laneAgent = await mk("Lane", "Background Developer");
  const dev = await mk("Dev", "Developer");
  let n = 0;
  const q = checkQueue(db);
  if (opts.train ?? true) await q.setTrain(true);
  await q.setSlots(opts.slots ?? 4);
  const ticket = async (o: { lane?: boolean } = {}) => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `T${n}`, number: n, assigneeAgentId: o.lane ? laneAgent : dev }).returning();
    return t!.id;
  };
  const job = async (ticketId: string, o: { minutesAgo: number; kind?: "merge" | "pre_review"; scope?: "quick" | "full"; fixesMain?: boolean }) => {
    const { job } = await q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId, kind: o.kind ?? "merge", scope: o.scope ?? "full", commit: `c-${ticketId}-${o.minutesAgo}`, tree: `t-${ticketId}-${o.minutesAgo}`, fixesMain: o.fixesMain, priority: 1 });
    await db.update(checkJobs).set({ queuedAt: new Date(Date.now() - o.minutesAgo * 60_000) }).where(eq(checkJobs.id, job.id));
    return job.id;
  };
  const merge = async (o: { lane?: boolean; minutesAgo: number; fixesMain?: boolean }) => {
    const id = await ticket(o);
    await job(id, o);
    return id;
  };
  const waiting = async () => (await q.list(co!.id)).rows.filter((r) => r.state === "waiting").map((r) => r.ticketId);
  const train = () => trainFor(p!.id, 3).train;
  const state = async (ticketId: string) => (await db.select({ s: checkJobs.state }).from(checkJobs).where(eq(checkJobs.ticketId, ticketId)))[0]?.s;
  return { db, q, co: co!, projectId: p!.id, ticket, job, merge, waiting, train, state };
}

describe("check queue follows the merge train (BOS-1504)", () => {
  it("serves a seated background-lane member before a later ordinary merge outside the train", async () => {
    const s = await setup({ slots: 1 });
    const head = await s.merge({ minutesAgo: 60 });
    const lane = await s.merge({ lane: true, minutesAgo: 50 });
    const outside = await s.merge({ minutesAgo: 5 }); // e.g. a landing on the old path
    // Without a train the lane ticket sorts last (BOS-1403).
    expect(await s.waiting()).toEqual([head, outside, lane]);
    const tr = s.train();
    tr.join(head, { priority: 1, place: 1 });
    tr.join(lane, { priority: 2, place: 2 });
    expect(tr.seated(lane)).toBe(true);
    // The head's job is running: its tier still counts for the member behind it.
    const [first] = await s.q.claimNext(null, new Date(), s.co.id);
    expect(first!.ticketId).toBe(head);
    expect(await s.waiting()).toEqual([lane, outside]);
  });

  it("serves members in seat order, even when a later seat has an older job or a better tier", async () => {
    const s = await setup();
    const a = await s.merge({ lane: true, minutesAgo: 10 });
    const b = await s.merge({ minutesAgo: 30 });
    const c = await s.merge({ minutesAgo: 50 });
    const tr = s.train();
    // Seated in this order (as a restart seed or admission would have it), whatever the jobs' own keys say.
    tr.seedOrder([a, b, c]);
    for (const [id, place] of [[c, 3], [b, 2], [a, 1]] as const) tr.join(id, { priority: 1, place });
    expect(tr.seated(c)).toBe(true);
    expect(tr.seatedIds()).toEqual([a, b, c]);
    expect(await s.waiting()).toEqual([a, b, c]);
  });

  it("doesn't claim the queued merge job of a ticket waiting for a seat, and says why", async () => {
    const s = await setup();
    const member = await s.merge({ minutesAgo: 30 });
    const waiter = await s.merge({ minutesAgo: 60 }); // older: before this change it took the slot
    const tr = trainFor(s.projectId, 1).train;
    tr.join(member, { priority: 1, place: 1 });
    tr.join(waiter, { priority: 1, place: 2 });
    expect(tr.seated(member)).toBe(true);
    expect(tr.seated(waiter)).toBe(false);
    const rows = (await s.q.list(s.co.id)).rows;
    const held = rows.find((r) => r.ticketId === waiter)!;
    expect(held.position).toBeNull();
    expect(held.heldBy).toMatch(/waiting for a seat in the merge train/);
    expect(held.heldByMain).toBe(false);
    expect((await s.q.status(s.co.id)).held).toEqual([expect.objectContaining({ ticketId: waiter, heldBy: "waiting for a seat in the merge train" })]);
    const claimed = await s.q.claimNext(null, new Date(), s.co.id);
    expect(claimed.map((j) => j.ticketId)).toEqual([member]);
    // A second pump with free slots still leaves it queued: it keeps its place for when it is seated.
    expect(await s.q.claimNext(null, new Date(), s.co.id)).toEqual([]);
    expect(await s.state(waiter)).toBe("queued");
  });

  it("holds back a seeded ticket after a restart until it is seated, but not past the seed", async () => {
    const s = await setup();
    const seeded = await s.merge({ minutesAgo: 60 });
    const tr = s.train();
    tr.seedOrder([seeded]);
    expect(await s.q.claimNext(null, new Date(), s.co.id)).toEqual([]);
    tr.join(seeded, { priority: 1, place: 1 });
    expect(tr.seated(seeded)).toBe(true);
    expect((await s.q.claimNext(null, new Date(), s.co.id)).map((j) => j.ticketId)).toEqual([seeded]);
  });

  it("still serves a waiting ticket's job that fixes main, and pre-review checks", async () => {
    const s = await setup();
    const member = await s.merge({ minutesAgo: 30 });
    const fixer = await s.merge({ minutesAgo: 10, fixesMain: true });
    const other = await s.ticket();
    await s.job(other, { kind: "pre_review", scope: "quick", minutesAgo: 1 });
    const tr = trainFor(s.projectId, 1).train;
    tr.join(member, { priority: 1, place: 1 });
    tr.join(fixer, { priority: 1, place: 2 });
    expect(tr.seated(fixer)).toBe(false);
    expect(await s.waiting()).toEqual([fixer, member, other]);
  });

  it("changes nothing with the switch off, or with no train in this process", async () => {
    const s = await setup({ train: false });
    const member = await s.merge({ minutesAgo: 30 });
    const waiter = await s.merge({ minutesAgo: 60 });
    const tr = trainFor(s.projectId, 1).train;
    tr.join(member, { priority: 1, place: 1 });
    tr.join(waiter, { priority: 1, place: 2 });
    tr.seated(member);
    expect(await s.waiting()).toEqual([waiter, member]);
    await s.q.setTrain(true);
    resetTrains(); // a restart: no train yet
    expect(await s.waiting()).toEqual([waiter, member]);
  });
});

describe("restart seed order (BOS-1504)", () => {
  it("orders by tier then place like admission: a background ticket queued first comes after an ordinary one; Move to front first", async () => {
    const s = await setup();
    const lane = await s.merge({ lane: true, minutesAgo: 60 });
    const ordinary = await s.merge({ minutesAgo: 30 });
    const later = await s.merge({ minutesAgo: 10 });
    expect(await s.q.liveMergeOrder(s.projectId)).toEqual([ordinary, later, lane]);
    await s.q.moveToFront(s.co.id, later, "Sam");
    expect(await s.q.liveMergeOrder(s.projectId)).toEqual([later, ordinary, lane]);
    // Ended jobs don't count.
    await s.db.update(checkJobs).set({ state: "passed", endedAt: new Date() }).where(eq(checkJobs.ticketId, ordinary));
    expect(await s.q.liveMergeOrder(s.projectId)).toEqual([later, lane]);
  });
});
