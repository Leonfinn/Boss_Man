import { afterAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { checkJobs, checkWorkers, companies, projects, tickets } from "../src/db/schema.js";
import { checkQueue, MACHINE_RUNNER } from "../src/services/check-queue.js";

// BOS-2218: a check retried after an out-of-memory loss stays off the machine that lost its test process, while another is up.
const shared = openPglite();
afterAll(async () => (await shared).close());

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: 1 }).returning();
  const [w] = await db.insert(checkWorkers).values({ name: "box", tokenHash: `h-${Math.random()}`, companyIds: [co!.id] }).returning();
  const q = checkQueue(db);
  const retry = (avoidMachine: string) => q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c", tree: "tree", avoidMachine });
  return { q, retry, workerId: w!.id, companyId: co!.id };
}
const NOW = new Date(Date.UTC(2026, 10, 22, 12, 0));

describe("out-of-memory retry placement", () => {
  it("a retry that avoids the worker is taken by the company runner, not the worker, while the runner is up", async () => {
    const s = await setup();
    const { job } = await s.retry(s.workerId);
    expect(job.avoidMachine).toBe(s.workerId);
    // The worker (another machine, the runner, is up) is passed over.
    expect(await s.q.claimOn({ workerId: s.workerId }, 2, NOW, s.companyId, undefined, { othersUp: true })).toEqual([]);
    const got = await s.q.claimOn(null, 2, NOW, s.companyId, undefined, { othersUp: true });
    expect(got.map((j) => j.id)).toEqual([job.id]);
  });

  it("a retry that avoids the runner goes to a worker", async () => {
    const s = await setup();
    const { job } = await s.retry(MACHINE_RUNNER);
    expect(await s.q.claimOn(null, 2, NOW, s.companyId, undefined, { othersUp: true })).toEqual([]);
    expect((await s.q.claimOn({ workerId: s.workerId }, 2, NOW, s.companyId, undefined, { othersUp: true })).map((j) => j.id)).toEqual([job.id]);
  });

  it("with no other machine online the retry falls back to the same machine", async () => {
    const s = await setup();
    const { job } = await s.retry(s.workerId);
    const got = await s.q.claimOn({ workerId: s.workerId }, 2, NOW, s.companyId, undefined, { othersUp: false });
    expect(got.map((j) => j.id)).toEqual([job.id]);
  });

  it("the retry keeps the place of the check it replaces", async () => {
    const s = await setup();
    const earlier = new Date(Date.UTC(2026, 10, 22, 10, 0));
    const { db } = await shared;
    const [p] = await db.select().from(projects);
    const [t] = await db.select().from(tickets);
    const { job } = await s.q.enqueue({ companyId: s.companyId, projectId: p!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c2", tree: "tree2", avoidMachine: s.workerId, placeAt: earlier });
    expect(job.queuedAt.getTime()).toBe(earlier.getTime());
  });
});
