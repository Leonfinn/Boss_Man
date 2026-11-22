// BOS-1942: where a running merge check runs is read from its real check job record, and follows the job when a worker drops out.
import { afterAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { checkJobs, checkWorkers, companies, projects, tickets } from "../src/db/schema.js";
import { checkQueue } from "../src/services/check-queue.js";
import { endedMergePlaces, runningCheckJobs } from "../src/services/merge-queue.js";

const shared = openPglite();
afterAll(async () => (await shared).close());
const T = (n: number) => new Date(Date.UTC(2026, 10, 4, 12, n));

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: 1 }).returning();
  const q = checkQueue(db);
  const job = (await q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: t!.id, kind: "merge", commit: "c1", tree: "t1" })).job;
  const worker = (await db.insert(checkWorkers).values({ name: "Truenas", tokenHash: `h-${Math.random()}`, companyIds: [co!.id] }).returning())[0]!;
  return { db, q, job, worker, companyId: co!.id, ticketId: t!.id };
}

describe("where a merge check runs (BOS-1942)", () => {
  it("follows the job: a named worker, then no place while it is requeued, then the server after the worker dropped out", async () => {
    const s = await setup();
    const w = await s.q.claimOn({ workerId: s.worker.id }, 1, T(1), s.companyId);
    expect(w.map((j) => j.id)).toEqual([s.job.id]);
    expect(await runningCheckJobs(s.db, s.companyId)).toMatchObject([{ ticketId: s.ticketId, kind: "merge", ranOn: "Truenas" }]);

    // The worker drops out: the job goes back in line and names no place.
    await s.q.requeueWorker(s.worker.id, "worker went away");
    expect(await runningCheckJobs(s.db, s.companyId)).toEqual([]);

    // The server takes it back.
    const back = await s.q.claimNext(null, T(2), s.companyId);
    expect(back.map((j) => j.id)).toEqual([s.job.id]);
    expect(await runningCheckJobs(s.db, s.companyId)).toMatchObject([{ ticketId: s.ticketId, ranOn: "company runner" }]);
  });

  it("says where the finished merge check ran for a landing that waits only for GitHub CI, and nothing for a ticket with no ended check", async () => {
    const s = await setup();
    await s.q.claimOn({ workerId: s.worker.id }, 1, T(1), s.companyId);
    expect((await endedMergePlaces(s.db, s.companyId, [s.ticketId])).size).toBe(0);
    await s.q.complete(s.job.id, { runnerId: { workerId: s.worker.id }, commit: "c1", exitCode: 0, logTail: "ok" }, T(5));
    expect((await endedMergePlaces(s.db, s.companyId, [s.ticketId])).get(s.ticketId)).toBe("Truenas");
    expect((await endedMergePlaces(s.db, s.companyId, [])).size).toBe(0);
  });
});
