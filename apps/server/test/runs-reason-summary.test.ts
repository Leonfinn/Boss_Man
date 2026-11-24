// BOS-2437: "Why runs started, last 7 days" (runs, share and cost per wake reason) and the reason filter on finished runs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { agents, companies, costEvents, fundingSources, runs, wakes } from "../src/db/schema.js";
import { runsService } from "../src/services/runs.js";

let close: () => Promise<void>;
let svc: ReturnType<typeof runsService>;
let companyId: string;
let otherId: string;

beforeAll(async () => {
  const pg = await openPglite(undefined, { fresh: true });
  close = pg.close;
  const [co] = await pg.db.insert(companies).values({ name: "Example Co", ticketPrefix: "BOS" }).returning();
  const [co2] = await pg.db.insert(companies).values({ name: "Other Co", ticketPrefix: "OTH" }).returning();
  companyId = co!.id;
  otherId = co2!.id;
  const [src] = await pg.db.insert(fundingSources).values({ name: "Example credit", kind: "api_credit", provider: "anthropic" }).returning();
  const day = 86_400_000;
  const mk = async (cId: string, reason: string | null, daysAgo: number, costMicros: number) => {
    const [a] = await pg.db.insert(agents).values({ companyId: cId, name: "Example Agent", role: "worker", agentKind: "claude" }).returning();
    const [r] = await pg.db
      .insert(runs)
      .values({ companyId: cId, agentId: a!.id, startedAt: new Date(Date.now() - daysAgo * day - 60_000), endedAt: new Date(Date.now() - daysAgo * day) })
      .returning();
    if (reason) await pg.db.insert(wakes).values({ companyId: cId, agentId: a!.id, reason, runId: r!.id });
    if (costMicros) await pg.db.insert(costEvents).values({ runId: r!.id, fundingSourceId: src!.id, companyId: cId, costMicros });
  };
  await mk(companyId, "verify failed", 1, 3_000_000);
  await mk(companyId, "verify failed", 2, 1_000_000);
  await mk(companyId, "chased", 1, 500_000);
  await mk(companyId, "review", 20, 9_000_000); // older than 7 days
  await mk(otherId, "chased", 1, 100_000);
  await mk(companyId, null, 1, 0);
  svc = runsService(pg.db, { runners: {} as never });
});
afterAll(async () => close?.());

describe("runsService.reasonSummary", () => {
  it("totals runs and cost per reason for the last 7 days, largest first, with shares", async () => {
    const rows = await svc.reasonSummary(companyId);
    expect(rows.map((r) => r.reason)).toEqual(["verify failed", "chased", null]);
    expect(rows[0]).toMatchObject({ runs: 2, costMicros: 4_000_000 });
    expect(rows[0]!.share).toBeCloseTo(0.5);
    expect(rows[1]).toMatchObject({ runs: 1, costMicros: 500_000 });
  });

  it("covers every company without a company filter", async () => {
    const rows = await svc.reasonSummary();
    expect(rows.find((r) => r.reason === "chased")).toMatchObject({ runs: 2, costMicros: 600_000 });
  });
});

describe("runsService.recent with reason", () => {
  it("lists only runs started for that reason", async () => {
    expect((await svc.recent(50, companyId, { reason: "verify failed" })).length).toBe(2);
    expect((await svc.recent(50, companyId, { reason: "review" })).length).toBe(1);
    expect((await svc.recent(50, companyId, { reason: "nothing" })).length).toBe(0);
  });

  it("still pages with before", async () => {
    const all = await svc.recent(50, companyId, { reason: "verify failed" });
    const older = await svc.recent(50, companyId, { reason: "verify failed", before: all[0]!.endedAt! });
    expect(older.map((r) => r.id)).toEqual([all[1]!.id]);
  });
});
