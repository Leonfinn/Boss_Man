// BOS-2849: the plain words behind a live check (check-wording.ts): checkPlace, ownLiveCheck and pendingFallback.
// checkPlace is passed a small fake queue, so it needs no database; the other two run against the in-memory database
// with rows inserted straight into the tables, as test/check-hold.test.ts does (no buildApp).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, tickets } from "../src/db/schema.js";
import { CARRY_ON_NOTE, checkPlace, ownLiveCheck, pendingFallback } from "../src/services/check-wording.js";
import type { CheckJob, checkQueue } from "../src/services/check-queue.js";

let ctx: Awaited<ReturnType<typeof setup>>;

beforeEach(async () => {
  ctx = await setup();
});

afterEach(async () => {
  await ctx.close();
});

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const agent = async (name: string) => (await db.insert(agents).values({ companyId: co!.id, name, role: "worker", agentKind: "claude" } as never).returning())[0]!;
  const worker = await agent("Worker");
  const other = await agent("Other");
  let n = 0;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, assigneeAgentId: worker.id, systemState: "in_progress", ...patch } as never).returning())[0]!;
  const job = async (ticketId: string, state: string, patch: Partial<typeof checkJobs.$inferInsert> = {}) =>
    (await db.insert(checkJobs).values({ companyId: co!.id, projectId: p!.id, ticketId, kind: "pre_review", scope: "quick", commit: "headcommit1", tree: `tree-${Math.random()}`, state, ...patch }).returning())[0]!;
  return { db, close, worker, other, ticket, job };
}

type Queue = ReturnType<typeof checkQueue>;

const fakeJob = (patch: Partial<CheckJob> = {}): CheckJob => ({ id: "job-1", state: "queued", ...patch }) as unknown as CheckJob;

const queueWith = (queued: Array<{ id: string; place: number }>): Queue => ({ status: async () => ({ queued }) }) as unknown as Queue;

describe("checkPlace", () => {
  it("says running now for a running job, without reading the queue", async () => {
    const queue = {
      status: async () => {
        throw new Error("a running job needs no queue status");
      },
    } as unknown as Queue;
    expect(await checkPlace(queue, "co-1", fakeJob({ state: "running" }))).toBe("running now");
  });

  it("gives the job's place in line when the queue lists it", async () => {
    const job = fakeJob({ id: "job-7" });
    const queue = queueWith([
      { id: "job-1", place: 1 },
      { id: "job-7", place: 3 },
    ]);
    expect(await checkPlace(queue, "co-1", job)).toBe("queued at no. 3");
  });

  it("says a red main holds it back when the queue does not list the job", async () => {
    const queue = queueWith([{ id: "job-1", place: 1 }]);
    expect(await checkPlace(queue, "co-1", fakeJob({ id: "job-9" }))).toBe("waiting (a red main holds back some checks)");
  });
});

describe("ownLiveCheck", () => {
  it("returns the agent's own queued job on the ticket", async () => {
    const { db, worker, ticket, job } = ctx;
    const t = await ticket();
    const j = await job(t.id, "queued", { requestedBy: worker.id });
    expect(await ownLiveCheck(db, t.id, worker.id)).toMatchObject({ id: j.id, state: "queued" });
  });

  it("returns the agent's own running job too", async () => {
    const { db, worker, ticket, job } = ctx;
    const t = await ticket();
    const j = await job(t.id, "running", { requestedBy: worker.id });
    expect(await ownLiveCheck(db, t.id, worker.id)).toMatchObject({ id: j.id, state: "running" });
  });

  it("returns null for a finished job", async () => {
    const { db, worker, ticket, job } = ctx;
    const t = await ticket();
    await job(t.id, "passed", { requestedBy: worker.id });
    expect(await ownLiveCheck(db, t.id, worker.id)).toBeNull();
  });

  it("returns null for another agent's job", async () => {
    const { db, worker, other, ticket, job } = ctx;
    const t = await ticket();
    await job(t.id, "queued", { requestedBy: other.id });
    expect(await ownLiveCheck(db, t.id, worker.id)).toBeNull();
  });

  it("returns null for a job on another ticket", async () => {
    const { db, worker, ticket, job } = ctx;
    const mine = await ticket();
    const otherTicket = await ticket();
    await job(otherTicket.id, "queued", { requestedBy: worker.id });
    expect(await ownLiveCheck(db, mine.id, worker.id)).toBeNull();
  });
});

describe("pendingFallback", () => {
  it("returns the booked time when the agent's own note set it", async () => {
    const { db, ticket } = ctx;
    const at = new Date(Date.now() + 15 * 60_000);
    const t = await ticket({ monitorAt: at, monitorNote: "check after the deploy" });
    expect(await pendingFallback(db, t.id, CARRY_ON_NOTE)).toEqual({ at });
  });

  it("returns null when no time is booked", async () => {
    const { db, ticket } = ctx;
    const t = await ticket({ monitorNote: "check after the deploy" });
    expect(await pendingFallback(db, t.id, CARRY_ON_NOTE)).toBeNull();
  });

  it("returns null for Boss Man's own carry-on wake", async () => {
    const { db, ticket } = ctx;
    const t = await ticket({ monitorAt: new Date(), monitorNote: CARRY_ON_NOTE });
    expect(await pendingFallback(db, t.id, CARRY_ON_NOTE)).toBeNull();
  });

  it("returns null for an unknown ticket id", async () => {
    const { db } = ctx;
    expect(await pendingFallback(db, "00000000-0000-0000-0000-000000000000", CARRY_ON_NOTE)).toBeNull();
  });
});
