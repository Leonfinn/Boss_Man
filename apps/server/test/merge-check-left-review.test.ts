// BOS-1757: a merge check whose ticket left review (sent back, GitHub bounce, cancelled) is stopped on its machine and its
// slot goes to the next check at once; a ticket still in review keeps its check.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { checkJobs, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { CHECK_QUEUE_MODE_KEY, checkQueue } from "../src/services/check-queue.js";
import { checkDispatcher } from "../src/services/check-dispatcher.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  await db.insert(settings).values([{ key: CHECK_QUEUE_MODE_KEY, value: "server" }, { key: "check_slots", value: 1 }]);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [r] = await db.insert(runners).values({ companyId: co!.id, tokenHash: `h${Math.random()}` } as never).returning();
  let n = 0;
  const ticket = async (state: "review" | "in_progress" = "review") => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `T${n}`, number: n, systemState: state }).returning();
    return t!.id;
  };
  const sent: Array<{ runnerId: string; command: any }> = [];
  const d = checkDispatcher(db, {
    drainPending: async () => false,
    send: (runnerId, command) => (sent.push({ runnerId, command }), true),
    isConnected: () => true,
    can: () => true,
    wake: async () => undefined,
  });
  const q = checkQueue(db);
  const merge = async (ticketId: string, tree: string) =>
    (await q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId, kind: "merge", scope: "full", commit: `c-${tree}`, tree } as never)).job;
  return { db, d, merge, ticket, sent, runner: r! };
}

describe("merge check of a ticket that left review (BOS-1757)", () => {
  it("stops the running check, records why, and starts the next queued one in the freed slot", async () => {
    const s = await setup();
    const gone = await s.ticket("review");
    const waiting = await s.ticket("review");
    const first = await s.merge(gone, "a");
    await s.merge(waiting, "b");
    await s.d.pump();
    expect(s.sent[0]!.command.jobId).toBe(first.id);
    // GitHub sent the ticket back.
    await s.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, gone));
    s.sent.length = 0;
    await s.d.sweep();
    const [row] = await s.db.select().from(checkJobs).where(eq(checkJobs.id, first.id));
    expect(row!.state).toBe("cancelled");
    expect(row!.reason).toMatch(/left review/);
    expect(s.sent.some((m) => m.command.type === "check.cancel" && m.command.jobId === first.id)).toBe(true);
    expect(s.sent.some((m) => m.command.type !== "check.cancel" && m.command.jobId !== first.id)).toBe(true);
  });

  it("leaves the check of a ticket that is still in review alone", async () => {
    const s = await setup();
    const kept = await s.merge(await s.ticket("review"), "k");
    await s.d.pump();
    await s.d.sweep();
    const [row] = await s.db.select().from(checkJobs).where(eq(checkJobs.id, kept.id));
    expect(row!.state).toBe("running");
  });

  it("also drops a queued merge check of a ticket that left review", async () => {
    const s = await setup();
    await s.merge(await s.ticket("review"), "r1");
    const queued = await s.merge(await s.ticket("in_progress"), "r2");
    await s.d.pump();
    await s.d.sweep();
    const [row] = await s.db.select().from(checkJobs).where(eq(checkJobs.id, queued.id));
    expect(row!.state).toBe("cancelled");
  });
});
