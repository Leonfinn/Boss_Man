// BOS-2752: the small database reads and updates on the failed-update hold (DR-076 A, BOS-2609). Each one works
// against the in-memory test database: the hold time from settings, the wake clock, the diagnosis link, ending a hold
// after a good update, and releasing holds past their time as "unknown".
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, ownerHolds, projects, settings, tickets } from "../src/db/schema.js";
import {
  HOLD_DEFAULT_MINUTES,
  HOLD_MINUTES_KEY,
  endHold,
  holdMinutes,
  linkNewDiagnosis,
  markWoken,
  openHold,
  timeOutHolds,
} from "../src/services/owner-holds.js";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db.insert(companies).values({ name: `Co ${randomUUID()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const ticket = async (title = "Diagnose the failed update") =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title }).returning())[0]!.id;
  return { db, close, ticket };
}

const hold = (over: Partial<Parameters<typeof openHold>[1]> = {}) =>
  openHold(ctx.db, { subject: "server_deploy", commit: "a".repeat(40), result: "failed", reason: "x", ...over });

const read = async (id: string) => (await ctx.db.select().from(ownerHolds).where(eq(ownerHolds.id, id)))[0]!;

describe("holdMinutes: the hold time from settings", () => {
  it.each([
    ["no row", undefined, HOLD_DEFAULT_MINUTES],
    ["30", 30, 30],
    ["5", 5, 5],
    ["1440 (one day)", 1440, 1440],
    ["4 (below the range)", 4, HOLD_DEFAULT_MINUTES],
    ["1441 (above the range)", 1441, HOLD_DEFAULT_MINUTES],
    ["12.5 (not a whole minute)", 12.5, HOLD_DEFAULT_MINUTES],
    ["abc (not a number)", "abc", HOLD_DEFAULT_MINUTES],
  ] as Array<[string, unknown, number]>)("%s gives %i", async (_label, value, expected) => {
    if (value !== undefined) await ctx.db.insert(settings).values({ key: HOLD_MINUTES_KEY, value });
    expect(await holdMinutes(ctx.db)).toBe(expected);
  });
});

describe("markWoken: records the wake and restarts the chase clock", () => {
  it("sets wokenAt, clears chasedAt, and leaves another hold untouched", async () => {
    const at = new Date("2026-11-26T09:05:00Z");
    const chased = new Date("2026-11-26T09:20:00Z");
    const server = await hold({ now: new Date("2026-11-26T09:00:00Z") });
    const runner = await hold({ subject: "runner_update", commit: "b".repeat(40), now: new Date("2026-11-26T09:00:00Z") });
    await ctx.db.update(ownerHolds).set({ chasedAt: chased });
    await markWoken(ctx.db, server.id, at);
    expect(await read(server.id)).toMatchObject({ wokenAt: at, chasedAt: null });
    expect(await read(runner.id)).toMatchObject({ wokenAt: null, chasedAt: chased });
  });
});

describe("linkNewDiagnosis: links a ticket to a hold that has none", () => {
  it("links an open hold with no ticket and gives true", async () => {
    const h = await hold();
    const t = await ctx.ticket();
    expect(await linkNewDiagnosis(ctx.db, h.id, t)).toBe(true);
    expect((await read(h.id)).ticketId).toBe(t);
  });

  it("gives false and keeps the old ticket when the hold already has one", async () => {
    const h = await hold();
    const old = await ctx.ticket("Old diagnosis");
    const next = await ctx.ticket("New diagnosis");
    await linkNewDiagnosis(ctx.db, h.id, old);
    expect(await linkNewDiagnosis(ctx.db, h.id, next)).toBe(false);
    expect((await read(h.id)).ticketId).toBe(old);
  });

  it("gives false on a hold that has ended", async () => {
    const h = await hold({ subject: "runner_update", commit: "b".repeat(40) });
    const t = await ctx.ticket();
    await endHold(ctx.db, "runner_update", new Date("2026-11-26T10:00:00Z"));
    expect(await linkNewDiagnosis(ctx.db, h.id, t)).toBe(false);
    expect((await read(h.id)).ticketId).toBeNull();
  });
});

describe("endHold: a good update ends only its own subject's hold", () => {
  it("ends the open server_deploy hold and leaves the runner_update hold open", async () => {
    const started = new Date("2026-11-26T09:00:00Z");
    const now = new Date("2026-11-26T10:30:00Z");
    const server = await hold({ now: started });
    const runner = await hold({ subject: "runner_update", commit: "b".repeat(40), now: started });
    await endHold(ctx.db, "server_deploy", now);
    expect((await read(server.id)).endedAt).toEqual(now);
    expect((await read(runner.id)).endedAt).toBeNull();
  });
});

describe("timeOutHolds: releases holds past their time as unknown", () => {
  it("returns a hold at or past its release time, released as unknown, and changes nothing else", async () => {
    const now = new Date("2026-11-26T12:00:00Z");
    // A hold that is already ended, past its own release time: never returned.
    const ended = await hold({ now: new Date(now.getTime() - 500 * 60_000) });
    await endHold(ctx.db, "server_deploy", new Date(now.getTime() - 450 * 60_000));
    // Release time is exactly now: "at or before now" includes it.
    const due = await hold({ now: new Date(now.getTime() - HOLD_DEFAULT_MINUTES * 60_000) });
    // Release time is still ahead: left alone.
    const future = await hold({ subject: "runner_update", commit: "b".repeat(40), now });

    const released = await timeOutHolds(ctx.db, now);

    expect(released.map((h) => h.id)).toEqual([due.id]);
    expect(released[0]).toMatchObject({ releasedBy: "timeout", outcome: "unknown", releasedAt: now });
    expect((await read(due.id)).releasedAt).toEqual(now);
    expect(await read(ended.id)).toMatchObject({ releasedAt: null, releasedBy: null, outcome: null });
    expect(await read(future.id)).toMatchObject({ releasedAt: null, releasedBy: null, outcome: null });
  });

  it("leaves an already released hold alone even when its time has passed", async () => {
    const now = new Date("2026-11-26T12:00:00Z");
    const releasedAt = new Date(now.getTime() - 100 * 60_000);
    const h = await hold({ now: new Date(now.getTime() - 200 * 60_000) });
    await ctx.db
      .update(ownerHolds)
      .set({ releasedAt, releasedBy: "Someone", outcome: "retry_safe" })
      .where(eq(ownerHolds.id, h.id));

    expect(await timeOutHolds(ctx.db, now)).toEqual([]);
    expect(await read(h.id)).toMatchObject({ releasedAt, releasedBy: "Someone", outcome: "retry_safe" });
  });
});
