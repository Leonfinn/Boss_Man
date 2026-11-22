// BOS-2179: when two open tickets' branches change the same files, both tickets show it and each gets one note per
// pair, again only when a new shared file appears. Lock and generated files don't count, and only open tickets of the
// same project are compared. Advisory: nothing is linked or held. (The move-to-review path and the ticket page are
// covered in merge-line-conflicts.test.ts, which runs the real app.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { activity, companies, projects, ticketDependencies, ticketMessages, tickets } from "../src/db/schema.js";
import { BRANCH_OVERLAP_KIND, branchOverlapView, countsForOverlap, NOT_COUNTED, noteBranchOverlaps, overlapNoteText, recordBranchFiles } from "../src/services/branch-overlaps.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await openPglite());
});
afterAll(async () => close());

let n = 0;
async function company() {
  const [co] = await db.insert(companies).values({ name: `Co ${++n}`, ticketPrefix: "BOS" }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const ticket = async (title: string, state: "in_progress" | "review" | "blocked" | "done" | "backlog" = "in_progress", projectId = p!.id) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId, title, number: ++n, systemState: state }).returning())[0]!;
  return { co: co!, p: p!, ticket };
}
const notes = async (ticketId: string) => (await db.select().from(ticketMessages).where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.author, "system"))).orderBy(asc(ticketMessages.createdAt))).map((m) => m.text);
const rows = (ticketId: string) => db.select().from(activity).where(and(eq(activity.ticketId, ticketId), eq(activity.kind, BRANCH_OVERLAP_KIND)));

describe("files that never count (BOS-2179)", () => {
  it("lock and generated files are left out, in any folder; real code counts", () => {
    for (const p of ["pnpm-lock.yaml", "apps/runner/claude-pack/package-lock.json", "yarn.lock", "npm-shrinkwrap.json", "apps/server/drizzle/meta/_journal.json", "apps/server/drizzle/meta/0182_snapshot.json", "scripts/test-lines-baseline.json", "apps/web/tsconfig.tsbuildinfo"]) expect(countsForOverlap(p), p).toBe(false);
    for (const p of ["apps/server/src/app.ts", "apps/server/drizzle/0182_passed_update_hold.sql", "package.json", "docs/lock.yaml.md"]) expect(countsForOverlap(p), p).toBe(true);
    expect(NOT_COUNTED.every((n) => n.why.length > 0)).toBe(true);
  });
});

describe("one note per pair (BOS-2179)", () => {
  it("both tickets get one note naming the other; the same files again post nothing; a new shared file posts one more", async () => {
    const c = await company();
    const a = await c.ticket("Change the review page", "review");
    const b = await c.ticket("Change the merge line");
    await recordBranchFiles(db, a.id, ["src/review.ts", "src/merge.ts", "pnpm-lock.yaml"]);
    expect(await notes(a.id)).toHaveLength(0); // nothing to compare with yet
    await recordBranchFiles(db, b.id, ["src/merge.ts", "src/other.ts", "pnpm-lock.yaml"]);
    const [onA] = await notes(a.id);
    const [onB] = await notes(b.id);
    expect(onA).toBe(overlapNoteText({ ref: `BOS-${b.number}`, title: b.title, state: "in_progress" }, ["src/merge.ts"]));
    expect(onB).toContain(`Changes the same files as BOS-${a.number} "Change the review page" (in review): src/merge.ts.`);
    expect(onB).not.toContain("pnpm-lock.yaml");
    expect(onB).toContain("Advisory only: nothing is held");

    // Recorded again with the same shared file (a second move to review, an approval, a merge attempt, a restart): no repeat.
    await recordBranchFiles(db, b.id, ["src/merge.ts", "src/other.ts"]);
    await recordBranchFiles(db, a.id, ["src/review.ts", "src/merge.ts"]);
    expect(await notes(a.id)).toHaveLength(1);
    expect(await notes(b.id)).toHaveLength(1);

    // A shrinking set says nothing either.
    await recordBranchFiles(db, b.id, ["src/merge.ts"]);
    expect(await notes(a.id)).toHaveLength(1);

    // A new shared file: one more note on each side, naming it.
    await recordBranchFiles(db, b.id, ["src/merge.ts", "src/review.ts"]);
    expect(await notes(a.id)).toHaveLength(2);
    expect((await notes(b.id))[1]).toContain("src/review.ts");
    const [last] = (await rows(a.id)).sort((x, y) => y.at.getTime() - x.at.getTime());
    expect((last!.detail as { files: string[] }).files.sort()).toEqual(["src/merge.ts", "src/review.ts"]);

    // Advisory: nothing linked, both still where they were.
    expect(await db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, a.id))).toHaveLength(0);
    expect(await db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, b.id))).toHaveLength(0);
    const states = await db.select({ s: tickets.systemState }).from(tickets).where(eq(tickets.id, a.id));
    expect(states[0]!.s).toBe("review");
  });

  it("only lock files shared: no note and nothing on the page", async () => {
    const c = await company();
    const a = await c.ticket("A");
    const b = await c.ticket("B");
    await recordBranchFiles(db, a.id, ["pnpm-lock.yaml", "apps/server/drizzle/meta/_journal.json", "src/a.ts"]);
    await recordBranchFiles(db, b.id, ["pnpm-lock.yaml", "apps/server/drizzle/meta/_journal.json", "src/b.ts"]);
    expect(await notes(a.id)).toHaveLength(0);
    expect(await notes(b.id)).toHaveLength(0);
    const [row] = await db.select().from(tickets).where(eq(tickets.id, a.id));
    expect(await branchOverlapView(db, row!)).toEqual([]);
  });

  it("only open tickets of the same project are compared", async () => {
    const c = await company();
    const [otherProject] = await db.insert(projects).values({ companyId: c.co.id, name: "Website" }).returning();
    const mine = await c.ticket("Mine");
    const done = await c.ticket("Merged already", "done");
    const backlog = await c.ticket("Not started", "backlog");
    const elsewhere = await c.ticket("Other project", "in_progress", otherProject!.id);
    for (const t of [done, backlog, elsewhere]) await db.update(tickets).set({ diffFiles: ["src/shared.ts"] }).where(eq(tickets.id, t.id));
    await recordBranchFiles(db, mine.id, ["src/shared.ts"]);
    expect(await notes(mine.id)).toHaveLength(0);
    for (const t of [done, backlog, elsewhere]) expect(await notes(t.id)).toHaveLength(0);
  });

  it("an existing ticket with no recorded files (as every ticket was before this): no warning and no error", async () => {
    const c = await company();
    const old = await c.ticket("Opened before the change", "review");
    const fresh = await c.ticket("New work");
    const rowOf = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
    expect((await rowOf(old.id)).diffFiles).toEqual([]);
    expect(await branchOverlapView(db, await rowOf(old.id))).toEqual([]);
    expect(await noteBranchOverlaps(db, old.id)).toEqual([]);
    await recordBranchFiles(db, fresh.id, ["src/app.ts"]);
    expect(await branchOverlapView(db, await rowOf(fresh.id))).toEqual([]);
    expect(await notes(old.id)).toHaveLength(0);
    expect(await notes(fresh.id)).toHaveLength(0);
    // An empty list recorded (a runner that saw no files) changes nothing either.
    await recordBranchFiles(db, old.id, []);
    expect((await rowOf(old.id)).diffFiles).toEqual([]);
  });

  it("the page names up to 5 files and how many more, and clears once the other ticket is done", async () => {
    const c = await company();
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"].map((f) => `src/${f}`);
    const a = await c.ticket("A", "review");
    const b = await c.ticket("B", "blocked");
    await recordBranchFiles(db, a.id, files);
    await recordBranchFiles(db, b.id, files);
    expect((await notes(a.id))[0]).toContain("src/e.ts and 2 more");
    const rowOf = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
    expect(await branchOverlapView(db, await rowOf(a.id))).toEqual([{ ticketId: b.id, ref: `BOS-${b.number}`, title: "B", state: "blocked", files: files.slice(0, 5), more: 2 }]);
    await db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, b.id));
    expect(await branchOverlapView(db, await rowOf(a.id))).toEqual([]);
    // A closed ticket shows nothing of its own either.
    expect(await branchOverlapView(db, await rowOf(b.id))).toEqual([]);
    expect(await noteBranchOverlaps(db, b.id)).toEqual([]);
  });
});
