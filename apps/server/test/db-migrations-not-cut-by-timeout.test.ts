// BOS-2181 criterion 5: the statement timeout applies to the pool only. Migrations run first, on their own connection that
// is opened without it. No Postgres: pg is replaced by recorders.
import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
const poolOptions: Array<Record<string, unknown>> = [];
const clientOptions: Array<Record<string, unknown>> = [];
const clientQueries: string[] = [];

vi.mock("pg", () => {
  class Client {
    constructor(o: Record<string, unknown>) {
      clientOptions.push(o);
    }
    async connect() {}
    async query(q: string) {
      clientQueries.push(q);
      throw new Error("stop here");
    }
    async end() {}
  }
  class Pool {
    constructor(o: Record<string, unknown>) {
      events.push("pool created");
      poolOptions.push(o);
    }
    on() {}
    async connect() {}
    async end() {}
  }
  return { Client, Pool, default: { Client, Pool } };
});
vi.mock("../src/db/migrate-lib.js", async (orig) => {
  const real = await orig<typeof import("../src/db/migrate-lib.js")>();
  return { ...real, runMigrations: vi.fn(async () => void events.push("migrations ran")) };
});

beforeEach(() => {
  events.length = 0;
  poolOptions.length = 0;
  clientOptions.length = 0;
  clientQueries.length = 0;
});

describe("migrations and the statement timeout", () => {
  it("runs migrations before the pool exists, and the pool gets the statement timeout", async () => {
    process.env.BOSSMAN_DB_STATEMENT_TIMEOUT_MS = "50";
    try {
      const { openPostgres } = await import("../src/db/client.js");
      await openPostgres("postgres://example.invalid/db");
    } finally {
      delete process.env.BOSSMAN_DB_STATEMENT_TIMEOUT_MS;
    }
    expect(events).toEqual(["migrations ran", "pool created"]);
    expect(poolOptions[0]).toMatchObject({ statement_timeout: 50 });
  });

  it("opens the migration connection without a statement timeout and never sets one", async () => {
    process.env.BOSSMAN_DB_STATEMENT_TIMEOUT_MS = "50";
    try {
      const { runMigrations } = await vi.importActual<typeof import("../src/db/migrate-lib.js")>("../src/db/migrate-lib.js");
      await expect(runMigrations("postgres://example.invalid/db", { folder: "/nonexistent" })).rejects.toThrow();
    } finally {
      delete process.env.BOSSMAN_DB_STATEMENT_TIMEOUT_MS;
    }
    expect(clientOptions).toHaveLength(1);
    expect(clientOptions[0]).not.toHaveProperty("statement_timeout");
    expect(clientQueries.join("\n")).not.toMatch(/statement_timeout/i);
  });
});
