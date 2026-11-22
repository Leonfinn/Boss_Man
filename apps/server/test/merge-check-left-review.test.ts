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

  it("leaves a running merge check alone when a quick check of the branch head is queued", async () => {
    const s = await setup();
    const t = await s.ticket("review");
    const running = await s.merge(t, "m");
    await s.d.pump();
    const { db } = s;
    const [tk] = await db.select().from(tickets).where(eq(tickets.id, t));
    await checkQueue(db).enqueue({ companyId: tk!.companyId, projectId: tk!.projectId, ticketId: t, kind: "quick", scope: "quick", commit: "c-head", tree: "head" } as never);
    await s.d.sweep();
    const [row] = await db.select().from(checkJobs).where(eq(checkJobs.id, running.id));
    expect(row!.state).toBe("running");
  });

  it("stops a running merge check once a newer merge check of the same ticket is queued", async () => {
    const s = await setup();
    const t = await s.ticket("review");
    const old = await s.merge(t, "old");
    await s.d.pump();
    const { db } = s;
    await s.merge(t, "new");
    await s.d.sweep();
    const [row] = await db.select().from(checkJobs).where(eq(checkJobs.id, old.id));
    expect(row!.state).toBe("cancelled");
    expect(row!.reason).toMatch(/newer commit/);
  });

  // BOS-1816: a running quick check of a commit that is no longer the ticket's head is superseded, not failed, and frees its slot.
  it("stops a running quick check once a quick check of a newer commit of the ticket is queued", async () => {
    const s = await setup();
    const t = await s.ticket("in_progress");
    const [tk] = await s.db.select().from(tickets).where(eq(tickets.id, t));
    const quick = async (tree: string) =>
      (await checkQueue(s.db).enqueue({ companyId: tk!.companyId, projectId: tk!.projectId, ticketId: t, kind: "quick", scope: "quick", commit: `c-${tree}`, tree } as never)).job;
    const old = await quick("old");
    await s.d.pump();
    expect(s.sent[0]!.command.jobId).toBe(old.id);
    const fresh = await quick("new");
    s.sent.length = 0;
    await s.d.sweep();
    const [row] = await s.db.select().from(checkJobs).where(eq(checkJobs.id, old.id));
    expect(row!.state).toBe("cancelled");
    expect(row!.reason).toMatch(/newer commit/);
    expect(s.sent.some((m) => m.command.type === "check.cancel" && m.command.jobId === old.id)).toBe(true);
    expect(s.sent.some((m) => m.command.type !== "check.cancel" && m.command.jobId === fresh.id)).toBe(true);
  });

  it("leaves a running quick check alone when only another ticket has a newer one", async () => {
    const s = await setup();
    const a = await s.ticket("in_progress");
    const b = await s.ticket("in_progress");
    const [tk] = await s.db.select().from(tickets).where(eq(tickets.id, a));
    const quick = async (ticketId: string, tree: string) =>
      (await checkQueue(s.db).enqueue({ companyId: tk!.companyId, projectId: tk!.projectId, ticketId, kind: "quick", scope: "quick", commit: `c-${tree}`, tree } as never)).job;
    const keep = await quick(a, "a1");
    await s.d.pump();
    await quick(b, "b1");
    await s.d.sweep();
    const [row] = await s.db.select().from(checkJobs).where(eq(checkJobs.id, keep.id));
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
