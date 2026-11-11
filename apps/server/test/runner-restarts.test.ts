// BOS-594: every runner restart gets a reason (update, setting change, owner restart, host, crash or out of
// memory), recorded in the feed and kept for server_status.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { activity, companies, runners, settings } from "../src/db/schema.js";
import { classifyRestart, expectRestart, INTENT_TTL_MS, lastRestart, recordRestart, type LastRestart } from "../src/services/runner-restarts.js";

const AT = new Date("2026-11-06T16:00:45Z");
const MIN = 60_000;
const HOST_BOOT = "2026-11-05T16:28:00.000Z";
const prev: LastRestart = { at: "2026-11-06T13:26:00Z", reason: "update", detail: "", bootId: "b0", hostBootAt: HOST_BOOT };

describe("classifyRestart", () => {
  it("uses Boss Man's own intent first, while it is fresh", () => {
    for (const reason of ["update", "setting change", "owner restart"] as const)
      expect(classifyRestart({ intent: { reason, at: new Date(AT.getTime() - 2 * MIN).toISOString() }, hello: { bootId: "b1", previousExit: "stopped", hostBootAt: HOST_BOOT }, previous: prev, at: AT }).reason).toBe(reason);
  });

  it("ignores a stale intent and reads what the runner said", () => {
    const stale = { reason: "update" as const, at: new Date(AT.getTime() - INTENT_TTL_MS - MIN).toISOString() };
    expect(classifyRestart({ intent: stale, hello: { bootId: "b1", previousExit: "crashed", hostBootAt: HOST_BOOT }, previous: prev, at: AT }).reason).toBe("crash or out of memory");
  });

  it("calls a moved host boot time, or a host that only just booted, a host restart", () => {
    expect(classifyRestart({ intent: null, hello: { bootId: "b1", previousExit: "crashed", hostBootAt: "2026-11-06T15:58:00.000Z" }, previous: prev, at: AT })).toMatchObject({ reason: "host" });
    // No earlier boot time to compare: a host up for 3 minutes rebooted; one up for a day did not.
    expect(classifyRestart({ intent: null, hello: { bootId: "b1", hostBootAt: "2026-11-06T15:57:45.000Z" }, previous: null, at: AT }).reason).toBe("host");
    expect(classifyRestart({ intent: null, hello: { bootId: "b1", previousExit: "crashed", hostBootAt: HOST_BOOT }, previous: null, at: AT }).reason).toBe("crash or out of memory");
    // A second of btime wobble is not a reboot.
    expect(classifyRestart({ intent: null, hello: { bootId: "b1", previousExit: "crashed", hostBootAt: "2026-11-05T16:28:01.000Z" }, previous: prev, at: AT }).reason).toBe("crash or out of memory");
  });

  it("calls a stop from outside Boss Man a host restart, and says it was done on the host", () => {
    // 6 Nov 16:00: recreate-all typed on the host for a setting change. Boss Man asked for nothing.
    const r = classifyRestart({ intent: null, hello: { bootId: "b1", previousExit: "stopped", hostBootAt: HOST_BOOT }, previous: prev, at: AT });
    expect(r.reason).toBe("host");
    expect(r.detail).toContain("outside Boss Man");
  });

  it("is unknown when an older runner says nothing", () => {
    expect(classifyRestart({ intent: null, hello: { bootId: "b1" }, previous: prev, at: AT }).reason).toBe("unknown");
  });
});

describe("recordRestart", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("keeps the latest restart for server_status, writes the feed, and uses an intent once", async () => {
    const pg = await openPglite();
    close = pg.close;
    const db = pg.db;
    const [co] = await db.insert(companies).values({ name: "Co" }).returning();
    const [runner] = await db.insert(runners).values({ companyId: co!.id, tokenHash: "x", bootId: "b0" }).returning();

    await expectRestart(db, co!.id, "setting change", new Date(AT.getTime() - MIN));
    const first = await recordRestart(db, runner!, { bootId: "b1", previousExit: "stopped", hostBootAt: HOST_BOOT }, { firstBoot: false, at: AT });
    expect(first).toMatchObject({ reason: "setting change", bootId: "b1", hostBootAt: HOST_BOOT });
    expect(await lastRestart(db, runner!.id)).toEqual(first);
    expect(await db.select().from(settings).where(eq(settings.key, `runner-restart-intent:${co!.id}`))).toEqual([]);

    // The next restart, unasked and without a stop: a crash, not the used-up setting change.
    const second = await recordRestart(db, runner!, { bootId: "b2", previousExit: "crashed", hostBootAt: HOST_BOOT }, { firstBoot: false, at: new Date(AT.getTime() + MIN) });
    expect(second.reason).toBe("crash or out of memory");

    const feed = await db.select().from(activity).where(eq(activity.kind, "runner_restart"));
    expect(feed.map((f) => f.summary)).toEqual([expect.stringContaining("Runner restarted (setting change)"), expect.stringContaining("Runner restarted (crash or out of memory)")]);
    expect(feed[1]!.detail).toMatchObject({ reason: "crash or out of memory", bootId: "b2", previousExit: "crashed" });
  });

  it("only takes a baseline on a runner's first boot: nothing restarted, so nothing goes in the feed", async () => {
    const pg = await openPglite();
    close = pg.close;
    const db = pg.db;
    const [co] = await db.insert(companies).values({ name: "Co" }).returning();
    const [runner] = await db.insert(runners).values({ companyId: co!.id, tokenHash: "x" }).returning();
    await recordRestart(db, runner!, { bootId: "b1", hostBootAt: HOST_BOOT }, { firstBoot: true, at: AT });
    expect(await db.select().from(activity).where(eq(activity.kind, "runner_restart"))).toEqual([]);
    expect((await lastRestart(db, runner!.id))?.hostBootAt).toBe(HOST_BOOT);
  });
});
