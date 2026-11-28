// BOS-2790: ticketsOfMilestones is the one rule for which tickets count toward a milestone (BOS-2560). These tests
// pin the rule: the tickets put directly in a milestone, plus every ticket of its features; a ticket that names a
// milestone itself counts there even when its feature sits under another one; cancelled tickets only when asked;
// results carry the reference, assignee and merge facts, oldest first.
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { agents, companies, features, milestones, objectives, projects, tickets } from "../src/db/schema.js";
import { ticketsOfMilestones } from "../src/services/milestone-tickets.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}`, ticketPrefix: "MIL" }).returning();
  const [project] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [objective] = await db.insert(objectives).values({ companyId: co!.id, title: "Grow" }).returning();
  const [msA] = await db.insert(milestones).values({ objectiveId: objective!.id, title: "Alpha" }).returning();
  const [msB] = await db.insert(milestones).values({ objectiveId: objective!.id, title: "Beta" }).returning();
  const [msOther] = await db.insert(milestones).values({ objectiveId: objective!.id, title: "Other" }).returning();
  const [featA] = await db.insert(features).values({ companyId: co!.id, title: "Search", milestoneId: msA!.id }).returning();
  const [featB] = await db.insert(features).values({ companyId: co!.id, title: "Payments", milestoneId: msB!.id }).returning();
  const [featOther] = await db.insert(features).values({ companyId: co!.id, title: "Elsewhere", milestoneId: msOther!.id }).returning();
  const [ada] = await db.insert(agents).values({ companyId: co!.id, name: "Ada", role: "worker", agentKind: "claude" } as never).returning();

  let n = 0;
  const mk = async (title: string, createdAt: Date, patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (
      await db
        .insert(tickets)
        .values({ companyId: co!.id, projectId: project!.id, title, number: ++n, createdAt, ...patch } as never)
        .returning()
    )[0]!;

  const t = {
    // Put directly in the milestone, with an assignee and the merge facts.
    direct: await mk("Direct", new Date("2026-01-03T00:00:00Z"), { milestoneId: msA!.id, assigneeAgentId: ada!.id, mergeCommit: "abc123", goLiveWait: "server", watchUntil: new Date("2026-02-01T00:00:00Z") }),
    // No milestone of its own: counts under its feature's milestone.
    viaFeature: await mk("Via feature", new Date("2026-01-01T00:00:00Z"), { featureId: featA!.id }),
    // Names milestone A itself while its feature sits in milestone B: counts under A, once.
    both: await mk("Own milestone wins", new Date("2026-01-02T00:00:00Z"), { milestoneId: msA!.id, featureId: featB!.id }),
    // Unassigned, to check assignee comes through as null.
    loose: await mk("Unassigned", new Date("2026-01-04T00:00:00Z"), { milestoneId: msA!.id }),
    cancelled: await mk("Dropped", new Date("2026-01-05T00:00:00Z"), { milestoneId: msA!.id, systemState: "done", outcome: "cancelled" }),
    unrelatedMilestone: await mk("Other milestone", new Date("2026-01-06T00:00:00Z"), { milestoneId: msOther!.id }),
    unrelatedFeature: await mk("Other feature", new Date("2026-01-07T00:00:00Z"), { featureId: featOther!.id }),
    looseNoMilestone: await mk("No milestone", new Date("2026-01-08T00:00:00Z")),
  };
  return { db, close, co: co!.id, a: msA!.id, b: msB!.id, other: msOther!.id, t };
}

const ids = (rows: Awaited<ReturnType<typeof ticketsOfMilestones>>) => rows.map((r) => r.id);

describe("ticketsOfMilestones (BOS-2790)", () => {
  it("an empty id list gives [] without a query error", async () => {
    const c = (ctx = await setup());
    expect(await ticketsOfMilestones(c.db, [])).toEqual([]);
  });

  it("returns a ticket put directly in the milestone, with its reference, assignee and merge facts", async () => {
    const c = (ctx = await setup());
    const rows = await ticketsOfMilestones(c.db, [c.a]);
    const direct = rows.find((r) => r.id === c.t.direct.id)!;
    expect(direct).toMatchObject({
      milestoneId: c.a,
      title: "Direct",
      ref: `MIL-${c.t.direct.number}`,
      assignee: "Ada",
      mergeCommit: "abc123",
      goLiveWait: "server",
    });
    expect(direct.watchUntil).toEqual(new Date("2026-02-01T00:00:00Z"));
  });

  it("returns a ticket with no milestone of its own under its feature's milestone", async () => {
    const c = (ctx = await setup());
    const rows = await ticketsOfMilestones(c.db, [c.a]);
    expect(rows.find((r) => r.id === c.t.viaFeature.id)).toMatchObject({ milestoneId: c.a, assignee: null });
  });

  it("counts a ticket that names milestone A while its feature sits in B under A only, once", async () => {
    const c = (ctx = await setup());
    const rows = await ticketsOfMilestones(c.db, [c.a, c.b]);
    const hits = rows.filter((r) => r.id === c.t.both.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.milestoneId).toBe(c.a);
  });

  it("leaves a cancelled ticket out by default and includes it when asked", async () => {
    const c = (ctx = await setup());
    const off = await ticketsOfMilestones(c.db, [c.a]);
    expect(ids(off)).not.toContain(c.t.cancelled.id);
    const on = await ticketsOfMilestones(c.db, [c.a], { includeCancelled: true });
    expect(on.find((r) => r.id === c.t.cancelled.id)).toMatchObject({ outcome: "cancelled" });
  });

  it("orders results by createdAt, oldest first", async () => {
    const c = (ctx = await setup());
    const rows = await ticketsOfMilestones(c.db, [c.a]);
    const times = rows.map((r) => r.createdAt.getTime());
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(ids(rows)).toEqual([c.t.viaFeature.id, c.t.both.id, c.t.direct.id, c.t.loose.id]);
  });

  it("leaves out tickets in an unrelated milestone or feature", async () => {
    const c = (ctx = await setup());
    const rows = await ticketsOfMilestones(c.db, [c.a]);
    const got = ids(rows);
    expect(got).not.toContain(c.t.unrelatedMilestone.id);
    expect(got).not.toContain(c.t.unrelatedFeature.id);
    expect(got).not.toContain(c.t.looseNoMilestone.id);
  });

  it("comes back empty for a milestone that has no tickets", async () => {
    const c = (ctx = await setup());
    expect(await ticketsOfMilestones(c.db, ["00000000-0000-4000-8000-000000000000"])).toEqual([]);
  });
});
