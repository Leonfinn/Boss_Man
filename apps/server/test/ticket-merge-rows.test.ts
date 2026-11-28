// BOS-2848: the database side of every-merge bookkeeping (BOS-2653). recordTicketMerge stores one row per ticket and
// commit (lower case, facts from the files), recordedMergeKeys reads the rows already there back as keys, and
// companyMerges lists ticket_merges plus each ticket's latest merge. In-memory database only; no buildApp.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, projects, ticketMerges, tickets } from "../src/db/schema.js";
import { companyMerges, recordTicketMerge, recordedMergeKeys } from "../src/services/ticket-merges.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

const RUNNER_CODE = ["apps/runner/src/index.ts"];
const DOCS_ONLY = ["docs/guide.md"];

async function setup() {
  const { db } = await shared;
  await db.delete(ticketMerges);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", ...patch } as never).returning())[0]!;
  return { db, company: co!.id, project: p!.id, ticket };
}

describe("recordTicketMerge", () => {
  it("stores a new merge's commit in lower case with the runner facts from its files, and says it was new", async () => {
    const s = await setup();
    const t = await s.ticket();
    const at = new Date("2026-11-01T10:00:00Z");
    expect(await recordTicketMerge(s.db, { companyId: s.company, ticketId: t.id, commit: "ABCDEF123", at, files: RUNNER_CODE })).toBe(true);
    const rows = await s.db.select().from(ticketMerges).where(eq(ticketMerges.ticketId, t.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: s.company, ticketId: t.id, commit: "abcdef123", mergedAt: at, touchesRunner: true, touchesRunnerUpdate: false, deploysNothing: false });
  });

  it("leaves the first row alone when the same ticket and commit is recorded again", async () => {
    const s = await setup();
    const t = await s.ticket();
    const first = new Date("2026-11-01T10:00:00Z");
    await recordTicketMerge(s.db, { companyId: s.company, ticketId: t.id, commit: "abcdef123", at: first, files: RUNNER_CODE });
    expect(await recordTicketMerge(s.db, { companyId: s.company, ticketId: t.id, commit: "ABCDEF123", at: new Date("2026-11-02T10:00:00Z"), files: DOCS_ONLY })).toBe(false);
    const rows = await s.db.select().from(ticketMerges).where(eq(ticketMerges.ticketId, t.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ commit: "abcdef123", mergedAt: first, touchesRunner: true, touchesRunnerUpdate: false, deploysNothing: false });
  });

  it("treats a merge with no files as touching the runners, the other two facts unknown", async () => {
    const s = await setup();
    const t = await s.ticket();
    await recordTicketMerge(s.db, { companyId: s.company, ticketId: t.id, commit: "abcdef123", at: new Date("2026-11-01T10:00:00Z") });
    const [row] = await s.db.select().from(ticketMerges).where(eq(ticketMerges.ticketId, t.id));
    expect(row).toMatchObject({ touchesRunner: true, touchesRunnerUpdate: null, deploysNothing: null });
  });
});

describe("recordedMergeKeys", () => {
  it("returns an empty set for no tickets", async () => {
    const s = await setup();
    expect(await recordedMergeKeys(s.db, [])).toEqual(new Set());
  });

  it("returns ticketId:commit keys only for the tickets asked", async () => {
    const s = await setup();
    const asked = await s.ticket();
    const other = await s.ticket();
    await recordTicketMerge(s.db, { companyId: s.company, ticketId: asked.id, commit: "aaaa111", at: new Date("2026-11-01T10:00:00Z"), files: RUNNER_CODE });
    await recordTicketMerge(s.db, { companyId: s.company, ticketId: other.id, commit: "bbbb222", at: new Date("2026-11-01T11:00:00Z"), files: RUNNER_CODE });
    expect(await recordedMergeKeys(s.db, [asked.id])).toEqual(new Set([`${asked.id}:aaaa111`]));
    expect(await recordedMergeKeys(s.db, [asked.id, other.id])).toEqual(new Set([`${asked.id}:aaaa111`, `${other.id}:bbbb222`]));
  });
});

describe("companyMerges", () => {
  it("adds a ticket's latest merge when no row has it, and does not list it twice when a row has it in another case", async () => {
    const s = await setup();
    const onlyOnTicket = await s.ticket({ mergeCommit: "C0FFEE1", mergedAt: new Date("2026-11-01T10:00:00Z") });
    const both = await s.ticket({ mergeCommit: "DEADBEEF", mergedAt: new Date("2026-11-01T12:00:00Z") });
    await recordTicketMerge(s.db, { companyId: s.company, ticketId: both.id, commit: "deadbeef", at: new Date("2026-11-01T12:30:00Z"), files: RUNNER_CODE });

    const merges = await companyMerges(s.db, s.company);
    expect(merges.map((m) => `${m.ticketId}:${m.commit}`)).toEqual([`${onlyOnTicket.id}:c0ffee1`, `${both.id}:deadbeef`]);
  });

  it("keeps a ticket row and a ticket's own different commit as two merges", async () => {
    const s = await setup();
    const t = await s.ticket({ mergeCommit: "aaaa222", mergedAt: new Date("2026-11-02T10:00:00Z") });
    await recordTicketMerge(s.db, { companyId: s.company, ticketId: t.id, commit: "aaaa111", at: new Date("2026-11-01T10:00:00Z"), files: RUNNER_CODE });
    const merges = await companyMerges(s.db, s.company);
    expect(merges.map((m) => m.commit)).toEqual(["aaaa111", "aaaa222"]);
  });

  it("lists merges oldest first by merge time, whatever order the rows were written in", async () => {
    const s = await setup();
    const t = await s.ticket();
    await recordTicketMerge(s.db, { companyId: s.company, ticketId: t.id, commit: "bbbb222", at: new Date("2026-11-03T10:00:00Z"), files: RUNNER_CODE });
    await recordTicketMerge(s.db, { companyId: s.company, ticketId: t.id, commit: "aaaa111", at: new Date("2026-11-01T10:00:00Z"), files: RUNNER_CODE });
    const merges = await companyMerges(s.db, s.company);
    expect(merges.map((m) => m.commit)).toEqual(["aaaa111", "bbbb222"]);
  });

  it("falls back to when the ticket last changed state for a merge with no mergedAt", async () => {
    const s = await setup();
    const changed = new Date("2026-11-01T09:00:00Z");
    const t = await s.ticket({ mergeCommit: "abcdef123", stateChangedAt: changed });
    const merges = await companyMerges(s.db, s.company);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ ticketId: t.id, commit: "abcdef123", at: changed });
  });

  it("leaves another company's merges out", async () => {
    const s = await setup();
    const otherCompany = await setup();
    const mine = await s.ticket({ mergeCommit: "aaaa111", mergedAt: new Date("2026-11-01T10:00:00Z") });
    const theirs = await otherCompany.ticket({ mergeCommit: "bbbb222", mergedAt: new Date("2026-11-01T10:00:00Z") });
    await recordTicketMerge(otherCompany.db, { companyId: otherCompany.company, ticketId: theirs.id, commit: "cccc333", at: new Date("2026-11-01T11:00:00Z"), files: RUNNER_CODE });

    const merges = await companyMerges(s.db, s.company);
    expect(merges.map((m) => m.ticketId)).toEqual([mine.id]);
  });
});
