// BOS-2749: the small database reads and updates in review-holds.ts (heldTicketIds, endHolds, knownDiffFiles,
// pendingQuickCheck, failedQuickCheck), tested straight against the in-memory database with no app built.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { checkJobs, companies, projects, reviewHolds, tickets } from "../src/db/schema.js";
import { endHolds, failedQuickCheck, heldTicketIds, knownDiffFiles, pendingQuickCheck } from "../src/services/review-holds.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

async function setup(opts: { logQuery?: (sql: string) => void } = {}) {
  const { db, close } = await openPglite(undefined, opts);
  const [co] = await db
    .insert(companies)
    .values({ name: `Co ${Math.random()}` })
    .returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  let n = 0;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, ...patch }).returning())[0]!;
  const hold = async (ticketId: string, status = "open", patch: Partial<typeof reviewHolds.$inferInsert> = {}) =>
    (await db.insert(reviewHolds).values({ ticketId, reason: "held", status, ...patch }).returning())[0]!;
  const job = async (ticketId: string, patch: Partial<typeof checkJobs.$inferInsert> = {}) =>
    (
      await db
        .insert(checkJobs)
        .values({ companyId: co!.id, projectId: p!.id, ticketId, kind: "pre_review", scope: "quick", commit: "head1", tree: `tree-${Math.random()}`, state: "queued", ...patch })
        .returning()
    )[0]!;
  return { db, close, company: co!.id, project: p!.id, ticket, hold, job };
}

describe("heldTicketIds", () => {
  it("asks the database nothing for an empty list", async () => {
    const queries: string[] = [];
    const s = (ctx = await setup({ logQuery: (q) => queries.push(q) }));
    const t = await s.ticket();
    await s.hold(t.id, "open");
    queries.length = 0;
    const ids = [...(await heldTicketIds(s.db, []))];
    expect(ids).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("gives only the tickets with an open hold among the ones asked for", async () => {
    const s = (ctx = await setup());
    const open = await s.ticket();
    const cancelled = await s.ticket();
    const notAsked = await s.ticket();
    await s.hold(open.id, "open");
    await s.hold(cancelled.id, "cancelled");
    await s.hold(notAsked.id, "open");
    expect([...(await heldTicketIds(s.db, [open.id, cancelled.id]))]).toEqual([open.id]);
  });

  it("gives every ticket with an open hold when no list is passed", async () => {
    const s = (ctx = await setup());
    const a = await s.ticket();
    const released = await s.ticket();
    const b = await s.ticket();
    await s.hold(a.id, "open");
    await s.hold(released.id, "released");
    await s.hold(b.id, "open");
    expect(await heldTicketIds(s.db)).toEqual(new Set([a.id, b.id]));
  });
});

describe("endHolds", () => {
  it("cancels the ticket's open hold with who and when, and leaves another ticket's hold alone", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const other = await s.ticket();
    await s.hold(t.id, "open");
    await s.hold(other.id, "open");
    await endHolds(s.db, t.id, "Reviewer");
    const [row] = await s.db.select().from(reviewHolds).where(eq(reviewHolds.ticketId, t.id));
    expect(row).toMatchObject({ status: "cancelled", closedBy: "Reviewer" });
    expect(row!.closedAt).toBeInstanceOf(Date);
    const [otherRow] = await s.db.select().from(reviewHolds).where(eq(reviewHolds.ticketId, other.id));
    expect(otherRow).toMatchObject({ status: "open", closedBy: null, closedAt: null });
  });

  it("leaves an already-closed hold as it was", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    await s.hold(t.id, "released", { closedBy: "Alice", closedAt: new Date("2026-01-01T00:00:00Z") });
    await endHolds(s.db, t.id, "Bob");
    const [row] = await s.db.select().from(reviewHolds).where(eq(reviewHolds.ticketId, t.id));
    expect(row).toMatchObject({ status: "released", closedBy: "Alice" });
    expect(row!.closedAt!.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("knownDiffFiles", () => {
  it("gives a short stored list back", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket({ diffFiles: ["a.ts"] });
    expect(await knownDiffFiles(s.db, t.id)).toEqual(["a.ts"]);
  });

  it("is null for an empty list, an unknown ticket or a list cut at 2000 files", async () => {
    const s = (ctx = await setup());
    const empty = await s.ticket({ diffFiles: [] });
    expect(await knownDiffFiles(s.db, empty.id)).toBeNull();
    expect(await knownDiffFiles(s.db, "00000000-0000-0000-0000-000000000000")).toBeNull();
    const cut = await s.ticket({ diffFiles: Array.from({ length: 2000 }, (_, i) => `f${i}.ts`) });
    expect(await knownDiffFiles(s.db, cut.id)).toBeNull();
  });

  it("gives back a list just below the cut", async () => {
    const s = (ctx = await setup());
    const files = Array.from({ length: 1999 }, (_, i) => `f${i}.ts`);
    const t = await s.ticket({ diffFiles: files });
    expect(await knownDiffFiles(s.db, t.id)).toEqual(files);
  });
});

describe("pendingQuickCheck", () => {
  it("returns the newest pre_review job while it is queued or running", async () => {
    const s = (ctx = await setup());
    const queuedTicket = await s.ticket();
    const queued = await s.job(queuedTicket.id, { state: "queued", commit: "head1", queuedAt: at(1) });
    expect(await pendingQuickCheck(s.db, queuedTicket.id)).toMatchObject({ id: queued.id, commit: "head1", state: "queued" });
    const runningTicket = await s.ticket();
    const running = await s.job(runningTicket.id, { state: "running", commit: "head1", queuedAt: at(1) });
    expect(await pendingQuickCheck(s.db, runningTicket.id)).toMatchObject({ id: running.id, commit: "head1", state: "running" });
  });

  it("looks at the newest job only: an older pass does not matter once a new commit is queued", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    await s.job(t.id, { state: "passed", commit: "old", queuedAt: at(1) });
    const newest = await s.job(t.id, { state: "queued", commit: "new", queuedAt: at(2) });
    expect((await pendingQuickCheck(s.db, t.id))!.id).toBe(newest.id);
  });

  it("is null when the newest job has passed or failed", async () => {
    const s = (ctx = await setup());
    const passed = await s.ticket();
    await s.job(passed.id, { state: "passed", queuedAt: at(1) });
    expect(await pendingQuickCheck(s.db, passed.id)).toBeNull();
    const failed = await s.ticket();
    await s.job(failed.id, { state: "failed", queuedAt: at(1) });
    expect(await pendingQuickCheck(s.db, failed.id)).toBeNull();
  });

  it("is null for a running re-run of a commit whose quick check already passed", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    await s.job(t.id, { state: "passed", commit: "head1", queuedAt: at(1) });
    await s.job(t.id, { state: "running", commit: "head1", queuedAt: at(2) });
    expect(await pendingQuickCheck(s.db, t.id)).toBeNull();
  });

  it("is null with no pre_review job, and ignores jobs of another kind", async () => {
    const s = (ctx = await setup());
    const none = await s.ticket();
    expect(await pendingQuickCheck(s.db, none.id)).toBeNull();
    const merge = await s.ticket();
    await s.job(merge.id, { kind: "merge", state: "queued" });
    expect(await pendingQuickCheck(s.db, merge.id)).toBeNull();
  });
});

describe("failedQuickCheck", () => {
  it("gives the newest failure on the head, with its reason and log tail", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    await s.job(t.id, { state: "failed", commit: "head1", reason: "older", logTail: "old", queuedAt: at(1) });
    const newest = await s.job(t.id, { state: "failed", commit: "head1", reason: "typecheck failed", logTail: "the line", queuedAt: at(2) });
    expect(await failedQuickCheck(s.db, t.id, "head1")).toMatchObject({ id: newest.id, commit: "head1", reason: "typecheck failed", logTail: "the line" });
  });

  it("is null when any job on that commit passed", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    await s.job(t.id, { state: "passed", commit: "head1", queuedAt: at(1) });
    await s.job(t.id, { state: "failed", commit: "head1", queuedAt: at(2) });
    expect(await failedQuickCheck(s.db, t.id, "head1")).toBeNull();
  });

  it("is null for a failure on another commit, and still sees a failure on the head", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    await s.job(t.id, { state: "failed", commit: "other", queuedAt: at(1) });
    expect(await failedQuickCheck(s.db, t.id, "head1")).toBeNull();
    expect((await failedQuickCheck(s.db, t.id, "other"))!.commit).toBe("other");
  });

  it("is null with no jobs, when the newest job on the head has not failed, or for another kind", async () => {
    const s = (ctx = await setup());
    const none = await s.ticket();
    expect(await failedQuickCheck(s.db, none.id, "head1")).toBeNull();
    const running = await s.ticket();
    await s.job(running.id, { state: "running", commit: "head1" });
    expect(await failedQuickCheck(s.db, running.id, "head1")).toBeNull();
    const merge = await s.ticket();
    await s.job(merge.id, { kind: "merge", state: "failed", commit: "head1" });
    expect(await failedQuickCheck(s.db, merge.id, "head1")).toBeNull();
  });
});
