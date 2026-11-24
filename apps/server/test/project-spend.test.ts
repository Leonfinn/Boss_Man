import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, costEvents, fundingSources, projects, runs, tickets } from "../src/db/schema.js";
import { monthStartUtc, projectMonthlyTrend, projectSpendMicros } from "../src/services/project-spend.js";

let ctx: Awaited<ReturnType<typeof openPglite>> | undefined;
beforeEach(async () => {
  ctx = await openPglite();
});
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const db = () => ctx!.db;

async function setup() {
  const [company] = await db().insert(companies).values({ name: "Spend Co" }).returning();
  const [project] = await db().insert(projects).values({ companyId: company!.id, name: "Site" }).returning();
  const [other] = await db().insert(projects).values({ companyId: company!.id, name: "Other" }).returning();
  const [ticket] = await db().insert(tickets).values({ companyId: company!.id, projectId: project!.id, title: "Work" }).returning();
  const [otherTicket] = await db().insert(tickets).values({ companyId: company!.id, projectId: other!.id, title: "Elsewhere" }).returning();
  const [api] = await db().insert(fundingSources).values({ name: "API", kind: "api_credit", provider: "anthropic" }).returning();
  const [sub] = await db().insert(fundingSources).values({ name: "Sub", kind: "subscription", provider: "anthropic" }).returning();
  const run = async (ticketId: string) =>
    (await db().insert(runs).values({ companyId: company!.id, ticketId }).returning())[0]!.id;
  const cost = (runId: string, fundingSourceId: string, costMicros: number, extra: { occurredAt?: Date; chargedProjectId?: string } = {}) =>
    db().insert(costEvents).values({ runId, fundingSourceId, companyId: company!.id, costMicros, ...extra });
  return { company: company!, project: project!, other: other!, ticket: ticket!, otherTicket: otherTicket!, api: api!, sub: sub!, run, cost };
}

describe("monthStartUtc", () => {
  it("uses the UTC calendar month, not the local one", () => {
    expect(monthStartUtc(new Date("2026-01-31T23:30:00Z"))).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(monthStartUtc(new Date("2026-03-01T00:00:00Z"))).toEqual(new Date("2026-03-01T00:00:00Z"));
    // Just after midnight UTC on the 1st is still the previous day in a negative offset, but the month has begun in UTC.
    expect(monthStartUtc(new Date("2026-02-01T00:30:00Z"))).toEqual(new Date("2026-02-01T00:00:00Z"));
  });
});

describe("projectSpendMicros", () => {
  it("counts a cost on a run whose ticket is in the project", async () => {
    const s = await setup();
    await s.cost(await s.run(s.ticket.id), s.api.id, 3_000_000);
    expect(await projectSpendMicros(db(), s.project.id)).toBe(3_000_000);
  });

  it("charges a cost with chargedProjectId to that project, not the run's project", async () => {
    const s = await setup();
    await s.cost(await s.run(s.ticket.id), s.api.id, 2_000_000, { chargedProjectId: s.other.id });
    expect(await projectSpendMicros(db(), s.project.id)).toBe(0);
    expect(await projectSpendMicros(db(), s.other.id)).toBe(2_000_000);
  });

  it("leaves out a cost on a subscription funding source", async () => {
    const s = await setup();
    await s.cost(await s.run(s.ticket.id), s.sub.id, 9_000_000);
    await s.cost(await s.run(s.ticket.id), s.api.id, 1_000_000);
    expect(await projectSpendMicros(db(), s.project.id)).toBe(1_000_000);
  });

  it("leaves out older costs when since is given", async () => {
    const s = await setup();
    const old = new Date("2026-01-15T12:00:00Z");
    await s.cost(await s.run(s.ticket.id), s.api.id, 1_000_000, { occurredAt: old });
    await s.cost(await s.run(s.ticket.id), s.api.id, 500_000, { occurredAt: new Date("2026-01-02T00:00:00Z") });
    expect(await projectSpendMicros(db(), s.project.id, new Date("2026-01-01T00:00:00Z"))).toBe(1_500_000);
    expect(await projectSpendMicros(db(), s.project.id, new Date("2026-01-10T00:00:00Z"))).toBe(1_000_000);
  });

  it("gives 0 when the project has no costs", async () => {
    const s = await setup();
    expect(await projectSpendMicros(db(), s.project.id)).toBe(0);
  });
});

describe("projectMonthlyTrend (BOS-2369)", () => {
  it("gives six months oldest first, split into pay-as-you-go and plan, in the given zone, for this project only", async () => {
    const s = await setup();
    const now = new Date("2026-11-15T12:00:00Z");
    const r1 = await s.run(s.ticket.id);
    const r2 = await s.run(s.ticket.id);
    const ro = await s.run(s.otherTicket.id);
    await s.cost(r1, s.api.id, 2_000_000, { occurredAt: new Date("2026-11-10T10:00:00Z") });
    await s.cost(r1, s.sub.id, 500_000, { occurredAt: new Date("2026-11-10T10:00:00Z") });
    await s.cost(r2, s.api.id, 1_000_000, { occurredAt: new Date("2026-06-20T10:00:00Z") });
    await s.cost(ro, s.api.id, 9_000_000, { occurredAt: new Date("2026-11-10T10:00:00Z") });
    // Charged back to this project from another project's run.
    await s.cost(ro, s.api.id, 300_000, { occurredAt: new Date("2026-10-05T10:00:00Z"), chargedProjectId: s.project.id });
    // Before the window: left out.
    await s.cost(r1, s.api.id, 7_000_000, { occurredAt: new Date("2026-05-01T10:00:00Z") });
    // 00:30 on 1 Nov in Berlin is still 31 Oct in New York.
    await s.cost(r1, s.api.id, 40_000, { occurredAt: new Date("2026-10-31T23:30:00Z") });
    const utc = await projectMonthlyTrend(db(), s.project.id, { timeZone: "UTC", now });
    expect(utc.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(utc[0]).toMatchObject({ paygMicros: 1_000_000, planMicros: 0 });
    expect(utc[4]).toMatchObject({ paygMicros: 300_000 + 40_000 });
    expect(utc[5]).toMatchObject({ paygMicros: 2_000_000, planMicros: 500_000 });
    const ny = await projectMonthlyTrend(db(), s.project.id, { timeZone: "America/New_York", now });
    expect(ny[4]!.paygMicros).toBe(340_000);
    const berlin = await projectMonthlyTrend(db(), s.project.id, { timeZone: "Europe/Berlin", now });
    expect(berlin[4]!.paygMicros).toBe(300_000);
    expect(berlin[5]!.paygMicros).toBe(2_040_000);
    // Runs are counted by start month, this project's only.
    await db().insert(runs).values([
      { companyId: s.company.id, ticketId: s.ticket.id, startedAt: new Date("2026-09-03T10:00:00Z") },
      { companyId: s.company.id, ticketId: s.ticket.id, startedAt: new Date("2026-09-04T10:00:00Z") },
      { companyId: s.company.id, ticketId: s.otherTicket.id, startedAt: new Date("2026-09-04T10:00:00Z") },
    ]);
    const again = await projectMonthlyTrend(db(), s.project.id, { timeZone: "UTC", now });
    // The two runs made by setup started at the real clock, so they count in whichever month that is; compare only the dated month.
    expect(again[3]!.runs).toBe(2);
    expect(again.slice(0, 3).map((m) => m.runs)).toEqual([0, 0, 0]);
  });
});
