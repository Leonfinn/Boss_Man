import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { checkJobs, companies, projects, settings, tickets } from "../src/db/schema.js";
import { checkQueue } from "../src/services/check-queue.js";

// BOS-1344: a queued merge job takes a new commit and tree; a job a runner has claimed is never changed.
const shared = openPglite();
afterAll(async () => (await shared).close());

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: 1 }).returning();
  const q = checkQueue(db);
  const job = async (kind: "merge" | "pre_review" = "merge") => (await q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: t!.id, kind, scope: "full", commit: "c-old", tree: "t-old" })).job;
  return { db, q, job };
}

describe("retargeting a queued merge job (BOS-1344)", () => {
  it("changes commit and tree of a queued job and keeps its place in line", async () => {
    const s = await setup();
    const j = await s.job();
    const row = await s.q.retarget(j.id, { commit: "c-new", tree: "t-new" });
    expect(row).toMatchObject({ id: j.id, commit: "c-new", tree: "t-new", state: "queued" });
    expect(row!.queuedAt.getTime()).toBe(j.queuedAt.getTime());
  });

  it("refuses a job that is running, passed or gone, and leaves it as it was", async () => {
    const s = await setup();
    const j = await s.job();
    await s.q.claimNext(null);
    expect(await s.q.retarget(j.id, { commit: "c-new", tree: "t-new" })).toBeNull();
    await s.db.update(checkJobs).set({ state: "passed" }).where(eq(checkJobs.id, j.id));
    expect(await s.q.retarget(j.id, { commit: "c-new", tree: "t-new" })).toBeNull();
    expect(await s.q.retarget("00000000-0000-4000-8000-000000000000", { commit: "x", tree: "y" })).toBeNull();
    const [after] = await s.db.select().from(checkJobs).where(eq(checkJobs.id, j.id));
    expect(after).toMatchObject({ commit: "c-old", tree: "t-old" });
  });

  it("only retargets merge jobs, not pre-review checks", async () => {
    const s = await setup();
    const j = await s.job("pre_review");
    expect(await s.q.retarget(j.id, { commit: "c-new", tree: "t-new" })).toBeNull();
  });
});
