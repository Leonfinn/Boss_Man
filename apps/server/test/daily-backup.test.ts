// BOS-2176: the daily backup's status line and its one overdue alert. The backup service writes two settings rows
// (scripts/daily-backup.sh); the server only reads them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { alertClearing, clearWhenOf } from "../src/services/alert-clearing.js";
import { kindCeiling, kindRow } from "../src/services/alert-kinds.js";
import { backupFreshReason, dailyBackupService, dailyBackupStatus, FAILED_KEY, LAST_KEY } from "../src/services/daily-backup.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
const T0 = new Date("2026-11-21T09:00:00Z");
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

beforeEach(async () => {
  ({ db, close } = await openPglite());
});
afterEach(async () => {
  await close();
});

const put = (key: string, value: unknown) => db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });

function service(now: () => Date, raised: Array<Record<string, unknown>>, open = () => false) {
  return dailyBackupService(db, {
    now,
    homeCompany: async () => "co-1",
    isOpen: async () => open(),
    raise: async (i) => (raised.push(i), { id: "card-1" }),
  });
}

describe("daily backup status", () => {
  it("says nothing yet when no backup was recorded, and shows the time of the newest one once there is one", async () => {
    expect(await dailyBackupStatus(db, T0)).toMatchObject({ lastAt: null, failed: null, stale: false });
    await put(LAST_KEY, { at: "2026-11-21T03:00:00.000Z", file: "daily-2026-11-21-0300.sql.gz", bytes: 1234 });
    expect(await dailyBackupStatus(db, T0)).toMatchObject({ lastAt: "2026-11-21T03:00:00.000Z", file: "daily-2026-11-21-0300.sql.gz", bytes: 1234, stale: false });
  });

  it("carries the last failure, and ignores rows that are not shaped like the script writes them", async () => {
    await put(FAILED_KEY, { at: "2026-11-21T08:00:00Z", message: "The database dump failed" });
    expect((await dailyBackupStatus(db, T0)).failed).toEqual({ at: "2026-11-21T08:00:00Z", message: "The database dump failed" });
    await put(LAST_KEY, { at: "not a date" });
    expect((await dailyBackupStatus(db, T0)).lastAt).toBeNull();
  });

  it("is stale only after 36 hours", async () => {
    await put(LAST_KEY, { at: T0.toISOString(), file: "f", bytes: 1 });
    expect((await dailyBackupStatus(db, hours(35.9))).stale).toBe(false);
    expect((await dailyBackupStatus(db, hours(36.1))).stale).toBe(true);
  });
});

describe("daily backup alert", () => {
  it("gives an install with no backup yet 36 hours from the first look, then raises one owner alert, once", async () => {
    const raised: Array<Record<string, unknown>> = [];
    let now = T0;
    const s = service(() => now, raised, () => raised.length > 0);
    expect(await s.check()).toEqual({ raised: false }); // starts the clock
    now = hours(35);
    expect(await s.check()).toEqual({ raised: false });
    now = hours(37);
    expect(await s.check()).toEqual({ raised: true });
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: "daily_backup_stale", from: "owner", dedupeKey: "alert:daily-backup", clearWhen: [{ kind: "backupFresh" }] });
    expect(String(raised[0]!.question)).toContain("docker compose up -d backup");
    now = hours(80);
    expect(await s.check()).toEqual({ raised: false }); // the card is open: no second one
    expect(raised).toHaveLength(1);
  });

  it("raises when the newest backup is over 36 hours old and names the failure; a fresh one stays quiet", async () => {
    const raised: Array<Record<string, unknown>> = [];
    await put(LAST_KEY, { at: T0.toISOString(), file: "f", bytes: 1 });
    await put(FAILED_KEY, { at: hours(30).toISOString(), message: "The database dump failed" });
    const fresh = service(() => hours(20), raised);
    await fresh.check();
    expect(raised).toHaveLength(0);
    const late = service(() => hours(40), raised);
    await late.check();
    expect(raised).toHaveLength(1);
    expect(String(raised[0]!.question)).toContain("The last attempt failed: The database dump failed.");
  });

  it("the card closes by itself once a new backup is recorded, and a new overdue spell can raise again", async () => {
    await put(LAST_KEY, { at: T0.toISOString(), file: "f", bytes: 1 });
    expect(await backupFreshReason(db, hours(40))).toBeNull();
    await put(LAST_KEY, { at: hours(39).toISOString(), file: "g", bytes: 1 });
    expect(await backupFreshReason(db, hours(40))).toContain("a new automatic backup was saved");
    const raised: Array<Record<string, unknown>> = [];
    await service(() => hours(80), raised).check(); // 41 hours after the new one, nothing open
    expect(raised).toHaveLength(1);
  });

  it("is an owner-level kind whose closer is registered", async () => {
    expect(kindCeiling("daily_backup_stale", undefined)).toBe("owner");
    expect(kindRow("daily_backup_stale", undefined).topRung).toBe("owner");
    expect(clearWhenOf({ clearWhen: [{ kind: "backupFresh" }] })).toEqual([{ kind: "backupFresh" }]);
    expect(typeof alertClearing).toBe("function");
  });
});
