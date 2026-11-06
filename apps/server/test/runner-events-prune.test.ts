import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, runnerEvents, runners } from "../src/db/schema.js";
import { pruneRunnerEvents, runnerEventsDays } from "../src/services/housekeeping.js";

const DAY = 86_400_000;
describe("runner events prune (BOS-416)", () => {
  it("deletes old events in batches, keeps the newest per runner", async () => {
    const { db, close } = await openPglite();
    const now = new Date("2026-11-06T00:00:00Z");
    const [co] = await db.insert(companies).values({ name: "C", slug: "c" } as never).returning();
    const [rn] = await db.insert(runners).values({ companyId: co!.id, tokenHash: "x" }).returning();
    const ev = (seq: number, ageDays: number) => ({ runnerId: rn!.id, seq, type: "runner.log", payload: { message: "m" }, occurredAt: new Date(now.getTime() - ageDays * DAY) });
    await db.insert(runnerEvents).values([ev(1, 90), ev(2, 80), ev(3, 70), ev(4, 65), ev(5, 61), ev(6, 10), ev(7, 70)]);
    // seq 7 is the newest and old: it stays, as the resume point.
    const n = await pruneRunnerEvents(db, { days: 60, batch: 2, now });
    expect(n).toBe(5);
    const left = await db.select({ seq: runnerEvents.seq }).from(runnerEvents).orderBy(runnerEvents.seq);
    expect(left.map((r) => r.seq)).toEqual([6, 7]);
    expect(await pruneRunnerEvents(db, { days: 60, batch: 2, now })).toBe(0);
    await close();
  });
  it("reads the days setting", () => {
    expect(runnerEventsDays(undefined)).toBe(60);
    expect(runnerEventsDays("0")).toBe(60);
    expect(runnerEventsDays("abc")).toBe(60);
    expect(runnerEventsDays("30")).toBe(30);
  });
});
