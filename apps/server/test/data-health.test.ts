import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, serverSizeReadings } from "../src/db/schema.js";
import { limitCounts, recordLimitHit, resetLimitCounts } from "../src/db/limit-counts.js";
import { makeLimitWatcher, dbPoolLimits } from "../src/db/client.js";
import { maskQuery, dataHealthService } from "../src/services/data-health.js";

const GB = 1024 ** 3;
const DAY = 86_400_000;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  resetLimitCounts();
  await close?.();
  close = undefined;
});

const disk = (freeGb: number, totalGb = 100) => () => ({ bsize: 1024, blocks: (totalGb * GB) / 1024, bavail: (freeGb * GB) / 1024 });

async function setup(opts: { freeGb?: number; at?: Date } = {}) {
  const opened = await openPglite();
  close = opened.close;
  let clock = opts.at ?? new Date("2026-11-23T09:00:00Z");
  const [co] = await opened.db.insert(companies).values({ name: "Co" }).returning({ id: companies.id });
  const svc = dataHealthService(opened.db, { now: () => clock, statfs: disk(opts.freeGb ?? 50) });
  return { db: opened.db, svc, companyId: co!.id, setClock: (d: Date) => (clock = d) };
}

describe("maskQuery", () => {
  it("removes values and cuts at 80 characters", () => {
    expect(maskQuery("select * from users where email = 'a@example.com' and id = 42 and x = $1")).toBe("select * from users where email = ? and id = ? and x = ?");
    expect(maskQuery("select " + "a, ".repeat(60)).length).toBe(80);
    expect(maskQuery("insert into t values ('it''s secret', 7)")).not.toMatch(/secret|7/);
  });
  it("masks dollar-quoted text, with and without a tag", () => {
    expect(maskQuery("update t set a = $$top secret$$ where b = $tag$it's hidden$tag$ and c = 1")).toBe("update t set a = ? where b = ? and c = ?");
  });
  it("masks E'…' strings with escaped quotes", () => {
    expect(maskQuery("select * from t where a = E'it\\'s secret' and b = 2")).toBe("select * from t where a = ? and b = ?");
  });
  it("masks from a quote left open by the text limit to the end", () => {
    expect(maskQuery("select * from t where a = 'half a secret")).toBe("select * from t where a = ?");
    expect(maskQuery("select * from t where a = E'half \\'secret")).toBe("select * from t where a = ?");
    expect(maskQuery("select * from t where a = $$half secret")).toBe("select * from t where a = ?");
  });
});

describe("limit counts", () => {
  it("counts what the limit watcher sees, over the last 24 hours only", () => {
    const watch = makeLimitWatcher(dbPoolLimits({}), () => undefined);
    watch({ code: "57014", message: "canceling statement due to statement timeout" });
    watch({ message: "timeout exceeded when trying to connect" });
    watch({ message: "timeout exceeded when trying to connect" });
    expect(limitCounts()).toEqual({ statementTimeouts: 1, poolFull: 2 });
    recordLimitHit("statement", Date.now() - 2 * DAY);
    expect(limitCounts().statementTimeouts).toBe(1);
  });
});

describe("server health", () => {
  it("reads the disk and database size, and keeps one reading a day", async () => {
    const { svc, db } = await setup();
    const h = await svc.read();
    expect(h.disk).toMatchObject({ freeBytes: 50 * GB, totalBytes: 100 * GB, freePercent: 50 });
    expect(h.database.bytes).toBeGreaterThan(0);
    await svc.read();
    expect(await db.select().from(serverSizeReadings)).toHaveLength(1);
    expect(h.warnings).toEqual([]);
  });

  it("returns the last 14 daily readings, oldest first", async () => {
    const { svc, db } = await setup({ at: new Date("2026-11-23T09:00:00Z") });
    for (let i = 1; i <= 20; i++) {
      const day = new Date(Date.UTC(2026, 10, 23) - i * 86_400_000).toISOString().slice(0, 10);
      await db.insert(serverSizeReadings).values({ day, dbBytes: 1000 + i, recordedAt: new Date() });
    }
    const h = await svc.read();
    expect(h.history).toHaveLength(14);
    expect(h.history[0]!.day).toBe("2026-11-10");
    expect(h.history[13]!.day).toBe("2026-11-23");
    expect(h.history[12]).toEqual({ day: "2026-11-22", bytes: 1001 });
  });

  it("warns below 10% or 5 GB free, once a day per company", async () => {
    const low = await setup({ freeGb: 9 }); // 9% of 100 GB
    expect(await low.svc.checkWarnings()).toBe(1);
    expect(await low.svc.checkWarnings()).toBe(0);
    const [d] = await low.db.select().from(decisions).where(eq(decisions.companyId, low.companyId));
    expect(d!.question).toMatch(/9\.0 GB free of 100\.0 GB/);
    low.setClock(new Date("2026-11-24T09:00:00Z"));
    expect(await low.svc.checkWarnings()).toBe(1);
  });

  it("does not warn at 10% or more, and warns on under 5 GB of a small disk", async () => {
    const ok = await setup({ freeGb: 11 });
    expect(await ok.svc.checkWarnings()).toBe(0);
    await close?.();
    const small = await setup({ freeGb: 4 });
    const svc = dataHealthService(small.db, { now: () => new Date("2026-11-23T09:00:00Z"), statfs: disk(4, 20) });
    expect(await svc.checkWarnings()).toBe(1);
  });

  it("warns when the database grew more than 50% in 7 days", async () => {
    const { svc, db, companyId } = await setup();
    const now = await svc.read();
    const bytes = now.database.bytes!;
    await db.insert(serverSizeReadings).values({ day: "2026-11-16", dbBytes: Math.floor(bytes / 1.6) });
    const h = await svc.read();
    expect(h.database.growthPercent7d).toBeGreaterThanOrEqual(59);
    expect(h.warnings.join(" ")).toMatch(/grew \d+% in 7 days/);
    expect(await svc.checkWarnings()).toBe(1);
    expect((await db.select().from(decisions).where(eq(decisions.companyId, companyId)))[0]!.question).toMatch(/grew/);
  });

  it("does not warn on 40% growth", async () => {
    const { svc, db } = await setup();
    const bytes = (await svc.read()).database.bytes!;
    await db.insert(serverSizeReadings).values({ day: "2026-11-16", dbBytes: Math.floor(bytes / 1.4) });
    expect((await svc.read()).warnings).toEqual([]);
  });

  it("lists a query running over 60 s with its duration and text with values removed", async () => {
    const { db } = await setup();
    // PGlite has one connection, so no second one can be seen running: stub the pg_stat_activity answer, keep the rest real.
    const stubbed = Object.create(db) as typeof db;
    const real = db.execute.bind(db);
    stubbed.execute = (async (q: Parameters<typeof db.execute>[0]) =>
      JSON.stringify(q).includes("pg_stat_activity") ? { rows: [{ seconds: 75, query: `select * from users where email = 'jo@example.com' and token = $1 ${"x".repeat(100)}` }] } : real(q)) as typeof db.execute;
    const h = await dataHealthService(stubbed, { statfs: disk(50) }).read();
    expect(h.slowQueries).toHaveLength(1);
    expect(h.slowQueries[0]!.seconds).toBe(75);
    expect(h.slowQueries[0]!.query.length).toBeLessThanOrEqual(80);
    expect(h.slowQueries[0]!.query).not.toMatch(/jo@example|\$1/);
  });

  it("says 'not available' for an unreadable folder instead of failing", async () => {
    const opened = await openPglite();
    close = opened.close;
    const svc = dataHealthService(opened.db, { statfs: () => { throw new Error("nope"); } });
    expect((await svc.read()).disk).toBeNull();
  });
});
