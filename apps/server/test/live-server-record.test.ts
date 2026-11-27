// BOS-2753: the short database reads in go-live-wait.ts (serverIsGoLive, liveServerRecord) and
// standing-rules.ts (getStandingRules), tested straight against the in-memory database with no app built.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, settings } from "../src/db/schema.js";
import type { Db } from "../src/db/client.js";
import { liveServerRecord, serverIsGoLive } from "../src/services/go-live-wait.js";
import { getStandingRules } from "../src/services/standing-rules.js";

const SHA_UP = "0123456789ABCDEF0123456789ABCDEF01234567";
const SHA_DOWN = "fedcba9876543210fedcba9876543210fedcba98";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(): Promise<Db> {
  const opened = await openPglite();
  close = opened.close;
  return opened.db;
}

const makeCompany = async (db: Db, patch: Partial<typeof companies.$inferInsert> = {}) =>
  (await db.insert(companies).values({ name: `Co ${randomUUID()}`, ...patch }).returning())[0]!;

const putRecord = (db: Db, companyId: string, value: unknown) =>
  db.insert(settings).values({ key: `live_release:${companyId}`, value: value as object });

describe("serverIsGoLive", () => {
  it("is true only for the oldest company (the home company Boss Man's own server serves)", async () => {
    const db = await setup();
    const older = await makeCompany(db, { createdAt: new Date("2026-01-01T00:00:00Z") });
    const newer = await makeCompany(db, { createdAt: new Date("2026-02-01T00:00:00Z") });
    expect(await serverIsGoLive(db, older.id)).toBe(true);
    expect(await serverIsGoLive(db, newer.id)).toBe(false);
  });

  it("is false for a company that doesn't exist", async () => {
    const db = await setup();
    await makeCompany(db);
    expect(await serverIsGoLive(db, randomUUID())).toBe(false);
  });
});

describe("liveServerRecord", () => {
  it("gives nothing when no live_release row is kept for the company", async () => {
    const db = await setup();
    const co = await makeCompany(db);
    expect(await liveServerRecord(db, co.id)).toEqual({ live: null, contains: [] });
  });

  it("lower-cases the live commit and keeps only valid shas in contains, lower-cased", async () => {
    const db = await setup();
    const co = await makeCompany(db);
    await putRecord(db, co.id, { new: SHA_UP, contains: [SHA_UP, "not-a-sha", 123, null, { sha: SHA_DOWN }, SHA_DOWN] });
    expect(await liveServerRecord(db, co.id)).toEqual({ live: SHA_UP.toLowerCase(), contains: [SHA_UP.toLowerCase(), SHA_DOWN] });
  });

  it("gives no live commit when new is not a sha", async () => {
    const db = await setup();
    const co = await makeCompany(db);
    await putRecord(db, co.id, { new: "HEAD", contains: [] });
    expect(await liveServerRecord(db, co.id)).toEqual({ live: null, contains: [] });
  });

  it("gives an empty contains when it is not an array, keeping a valid new", async () => {
    const db = await setup();
    const co = await makeCompany(db);
    await putRecord(db, co.id, { new: SHA_UP, contains: "not-an-array" });
    expect(await liveServerRecord(db, co.id)).toEqual({ live: SHA_UP.toLowerCase(), contains: [] });
  });

  it("ignores another company's row", async () => {
    const db = await setup();
    const mine = await makeCompany(db);
    const other = await makeCompany(db);
    await putRecord(db, other.id, { new: SHA_UP, contains: [SHA_DOWN] });
    expect(await liveServerRecord(db, mine.id)).toEqual({ live: null, contains: [] });
  });
});

describe("getStandingRules", () => {
  it("gives empty text, no author and no time for a company with no rules", async () => {
    const db = await setup();
    const co = await makeCompany(db);
    expect(await getStandingRules(db, co.id)).toEqual({ text: "", by: null, at: null });
  });

  it("gives the text, author and time a company has", async () => {
    const db = await setup();
    const at = new Date("2026-03-04T05:06:07Z");
    const co = await makeCompany(db, { standingRules: "Be kind.\nShip small.", standingRulesBy: "the owner", standingRulesAt: at });
    expect(await getStandingRules(db, co.id)).toEqual({ text: "Be kind.\nShip small.", by: "the owner", at });
  });

  it("gives the empty result for a company that doesn't exist", async () => {
    const db = await setup();
    await makeCompany(db);
    expect(await getStandingRules(db, randomUUID())).toEqual({ text: "", by: null, at: null });
  });
});
