// BOS-2181: pool limits and the once-only log. The real-Postgres half runs when TEST_DATABASE_URL is set (CI provides it).
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { dbPoolLimits, makeLimitWatcher, openPostgres } from "../src/db/client.js";

describe("dbPoolLimits", () => {
  it("has generous defaults", () => {
    expect(dbPoolLimits({})).toEqual({ max: 20, connectTimeoutMs: 30_000, idleTimeoutMs: 30_000, statementTimeoutMs: 120_000 });
  });
  it("reads the overrides and ignores bad values", () => {
    expect(dbPoolLimits({ BOSSMAN_DB_POOL_MAX: "5", BOSSMAN_DB_CONNECT_TIMEOUT_MS: "1000", BOSSMAN_DB_STATEMENT_TIMEOUT_MS: "2500", BOSSMAN_DB_IDLE_TIMEOUT_MS: "9" })).toEqual({
      max: 5,
      connectTimeoutMs: 1000,
      idleTimeoutMs: 9,
      statementTimeoutMs: 2500,
    });
    expect(dbPoolLimits({ BOSSMAN_DB_POOL_MAX: "abc", BOSSMAN_DB_CONNECT_TIMEOUT_MS: "0", BOSSMAN_DB_STATEMENT_TIMEOUT_MS: "" }).max).toBe(20);
    expect(dbPoolLimits({ BOSSMAN_DB_CONNECT_TIMEOUT_MS: "-5" }).connectTimeoutMs).toBe(30_000);
  });
});

describe("makeLimitWatcher", () => {
  it("logs each kind once, naming which limit was hit, and ignores other errors", () => {
    const lines: string[] = [];
    const watch = makeLimitWatcher(dbPoolLimits({}), (m) => lines.push(m));
    const stmt = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    watch(stmt);
    watch(stmt);
    watch(new Error("timeout exceeded when trying to connect"));
    watch(new Error("timeout exceeded when trying to connect"));
    watch(new Error("syntax error"));
    watch(undefined);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("statement timeout");
    expect(lines[1]).toContain("no database connection free");
  });
});

const URL_ = process.env.TEST_DATABASE_URL;
describe.skipIf(!URL_)("real Postgres", () => {
  it("cancels a stuck query and fails fast when the pool is full", async () => {
    const saved = { ...process.env };
    process.env.BOSSMAN_DB_POOL_MAX = "1";
    process.env.BOSSMAN_DB_CONNECT_TIMEOUT_MS = "300";
    process.env.BOSSMAN_DB_STATEMENT_TIMEOUT_MS = "500";
    const { db, close } = await openPostgres(URL_!);
    try {
      const stuck = db.execute(sql`select pg_sleep(10)`);
      const waiting = db.execute(sql`select 1`); // the only connection is busy
      await expect(waiting).rejects.toThrow();
      await expect(stuck).rejects.toThrow();
      const ok = await db.execute(sql`select 1 as ok`); // the pool recovers
      expect((ok as unknown as { rows: unknown[] }).rows[0]).toEqual({ ok: 1 });
    } finally {
      for (const k of ["BOSSMAN_DB_POOL_MAX", "BOSSMAN_DB_CONNECT_TIMEOUT_MS", "BOSSMAN_DB_STATEMENT_TIMEOUT_MS"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await close();
    }
  }, 20_000);
});
