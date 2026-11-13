import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { checkJobs, companies, projects, settings, tickets } from "../src/db/schema.js";
import { checkQueue, PLACE_KEEP_MS, SUPERSEDED_TEXT } from "../src/services/check-queue.js";

// BOS-1328: a merge job that replaces an earlier merge job of the same ticket keeps the earlier job's place in line.
const shared = openPglite();
afterAll(async () => (await shared).close());

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  let n = 0;
  const ticket = async () => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `T${n}`, number: n }).returning();
    return t!.id;
  };
  const q = checkQueue(db);
  const req = async (ticketId: string, tree: string) =>
    (await q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId, kind: "merge", scope: "full", commit: `c-${tree}`, tree })).job;
  const age = (id: string, at: Date) => db.update(checkJobs).set({ queuedAt: at }).where(eq(checkJobs.id, id));
  return { db, q, req, ticket, age };
}

describe("a merge job keeps its ticket's place in line (BOS-1328)", () => {
  it("a re-queued merge of the same ticket (main moved) goes ahead of tickets queued after the first one", async () => {
    const s = await setup();
    const a = await s.ticket();
    const b = await s.ticket();
    const first = await s.req(a, "a1");
    await s.age(first.id, new Date(Date.now() - 60 * 60_000));
    const other = await s.req(b, "b1");
    // main moved: the same ticket asks again on another tree; the old queued one is replaced
    const again = await s.req(a, "a2");
    expect(again.queuedAt.getTime()).toBeLessThan(other.queuedAt.getTime());
    expect((await s.q.claimNext(null))[0]!.id).toBe(again.id);
  });

  it("a passed job that main moved past hands its place to the ticket's next job, for a limited time", async () => {
    const s = await setup();
    const a = await s.ticket();
    const old = await s.req(a, "a1");
    const start = new Date(Date.now() - 3 * 60 * 60_000);
    await s.age(old.id, start);
    await s.db.update(checkJobs).set({ state: "passed", endedAt: new Date() }).where(eq(checkJobs.id, old.id));
    const next = await s.req(a, "a2");
    expect(next.queuedAt.getTime()).toBe(start.getTime());
    // an old pass (past the keep window) is history, not a place
    const longAgo = new Date(Date.now() - PLACE_KEEP_MS - 60_000);
    await s.db.update(checkJobs).set({ state: "passed", endedAt: longAgo }).where(eq(checkJobs.id, next.id));
    await s.db.update(checkJobs).set({ endedAt: longAgo }).where(eq(checkJobs.id, old.id));
    const fresh = await s.req(a, "a3");
    expect(fresh.queuedAt.getTime()).toBeGreaterThan(start.getTime() + 60 * 60_000);
  });

  it("a deliberate cancel never lends its place, a 'newer commit' cancel does", async () => {
    const s = await setup();
    const a = await s.ticket();
    const old = await s.req(a, "a1");
    const start = new Date(Date.now() - 2 * 60 * 60_000);
    await s.age(old.id, start);
    await s.q.cancel(old.id, "Pulled back by the owner.");
    const again = await s.req(a, "a2");
    expect(again.queuedAt.getTime()).toBeGreaterThan(start.getTime() + 60 * 60_000);
    await s.age(again.id, start);
    await s.q.cancel(again.id, SUPERSEDED_TEXT);
    const third = await s.req(a, "a3");
    expect(third.queuedAt.getTime()).toBe(start.getTime());
  });

  it("a failed job never lends its place, and another ticket's job never does", async () => {
    const s = await setup();
    const a = await s.ticket();
    const b = await s.ticket();
    const old = await s.req(a, "a1");
    const start = new Date(Date.now() - 2 * 60 * 60_000);
    await s.age(old.id, start);
    await s.db.update(checkJobs).set({ state: "failed", endedAt: new Date() }).where(eq(checkJobs.id, old.id));
    const fixed = await s.req(a, "a2");
    expect(fixed.queuedAt.getTime()).toBeGreaterThan(start.getTime() + 60 * 60_000);
    const other = await s.req(b, "b1");
    expect(other.queuedAt.getTime()).toBeGreaterThan(start.getTime() + 60 * 60_000);
  });
});
