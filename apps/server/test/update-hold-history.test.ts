// BOS-2791: the append-only record of each update hold (BOS-2408), tested directly against PGlite.
// Each test opens its own in-memory Postgres, uses a fixed clock and closes it afterwards.
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { updateHolds } from "../src/db/schema.js";
import { LOST_TITLE, updateHoldHistory, type UpdateHoldHistory } from "../src/services/update-hold-history.js";

const T0 = new Date("2026-11-20T10:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;

type Hold = Parameters<UpdateHoldHistory["upsert"]>[0];
type Ctx = Awaited<ReturnType<typeof setup>>;

let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const clock = { now: T0 };
  const logs: string[] = [];
  const history = updateHoldHistory(db, () => clock.now, (m) => logs.push(m));
  return { db, close, clock, logs, history };
}

const at = (mins = 0) => new Date(T0.getTime() + mins * MIN).toISOString();
const hold = (over: Partial<Hold> = {}): Hold => ({ reason: "Runner update", since: at(), deadline: at(10), minutes: 10, ...over });
const rows = (c: Ctx) => c.db.select().from(updateHolds);
const one = async (c: Ctx) => (await rows(c))[0]!;

describe("upsert", () => {
  it("creates one row on the first save, with the kind defaulting to update", async () => {
    const c = (ctx = await setup());
    await c.history.upsert(hold());
    const all = await rows(c);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "update", reason: "Runner update", minutes: 10, endedAt: null });
    expect(all[0]!.startedAt.toISOString()).toBe(at());
    expect(all[0]!.deadline!.toISOString()).toBe(at(10));
    expect(all[0]!.events).toEqual([]);
  });

  it("updates reason, deadline and minutes on the same row when the same hold is saved again", async () => {
    const c = (ctx = await setup());
    await c.history.upsert(hold({ kind: "runner" }));
    await c.history.upsert(hold({ kind: "server", reason: "Server update", deadline: at(30), minutes: 30 }));
    const all = await rows(c);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "server", reason: "Server update", minutes: 30 });
    expect(all[0]!.deadline!.toISOString()).toBe(at(30));
  });

  it("records each flag's event once, and saving again with the flags still set adds nothing", async () => {
    const c = (ctx = await setup());
    const flags = {
      force: true,
      swapWhenDone: true,
      ignoreChecks: true,
      capNotified: true,
      ceoWokenAt: at(5),
      wentAheadAt: at(6),
      launcherDownSince: at(7),
      wrapSince: at(8),
    } as const;
    await c.history.upsert(hold(flags));
    const first = await one(c);
    expect(first.events).toHaveLength(8);
    expect(first.events.map((e) => e.text)).toEqual([
      "Stop-and-update-now chosen: runs still going are stopped",
      '"Swap as soon as these finish" chosen',
      '"Stop the checks and update now" chosen: checks are no longer waited for',
      "Hard cap passed with work still going: new work is no longer held",
      "CEO woken: the swap waited past its expected finish",
      "Drain reached its own end and went ahead by itself",
      "The launcher stopped answering",
      "Wrap-up asked",
    ]);
    expect(first.events.every((e) => e.at === at())).toBe(true);

    await c.history.upsert(hold(flags));
    expect((await one(c)).events).toHaveLength(8);
  });

  it("adds a flag's event as each flag first appears, keeping them in flag order", async () => {
    const c = (ctx = await setup());
    await c.history.upsert(hold({ force: true }));
    await c.history.upsert(hold({ force: true, wrapSince: at(4) }));
    expect((await one(c)).events.map((e) => e.text)).toEqual(["Stop-and-update-now chosen: runs still going are stopped", "Wrap-up asked"]);
  });
});

describe("event", () => {
  it("adds a text once and ignores the same text again", async () => {
    const c = (ctx = await setup());
    await c.history.upsert(hold());
    await c.history.event(at(), "Waiting on nothing nameable");
    await c.history.event(at(), "Waiting on nothing nameable");
    expect((await one(c)).events).toEqual([{ at: at(), text: "Waiting on nothing nameable" }]);
  });

  it("cuts text over 300 characters to 300, and still notes it only once", async () => {
    const c = (ctx = await setup());
    await c.history.upsert(hold());
    const long = "x".repeat(400);
    await c.history.event(at(), long);
    await c.history.event(at(), long);
    const events = (await one(c)).events;
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe("x".repeat(300));
  });

  it("adds nothing to a row that has ended", async () => {
    const c = (ctx = await setup());
    await c.history.upsert(hold());
    await c.history.close(at(), { ok: true, title: "done", body: "b" });
    await c.history.event(at(), "Too late");
    expect((await one(c)).events).toEqual([]);
  });
});

describe("swapTry", () => {
  it("appends the try with when it happened, and cuts an error to 300", async () => {
    const c = (ctx = await setup());
    await c.history.upsert(hold());
    await c.history.swapTry(at(), { slug: "runner-1", n: 2, outcome: "failed", error: "e".repeat(400) });
    c.clock.now = new Date(T0.getTime() + MIN);
    await c.history.swapTry(at(), { slug: "runner-1", n: 3, outcome: "started" });
    expect((await one(c)).swapTries).toEqual([
      { slug: "runner-1", n: 2, outcome: "failed", at: at(), error: "e".repeat(300) },
      { slug: "runner-1", n: 3, outcome: "started", at: at(1) },
    ]);
  });

  it("adds nothing after the row has ended", async () => {
    const c = (ctx = await setup());
    await c.history.upsert(hold());
    await c.history.close(at(), { ok: false, title: "failed", body: "b" });
    await c.history.swapTry(at(), { slug: "runner-1", n: 1, outcome: "failed" });
    expect((await one(c)).swapTries).toEqual([]);
  });
});

describe("close", () => {
  it("stamps the end, cuts the body to 1000 and keeps the final swapped and failed maps", async () => {
    const c = (ctx = await setup());
    await c.history.upsert(hold());
    c.clock.now = new Date(T0.getTime() + MIN);
    await c.history.close(at(), { ok: true, title: "Update done", body: "b".repeat(1200), swapped: { "runner-1": "v2" }, failed: { "runner-2": "boom" } });
    const row = await one(c);
    expect(row).toMatchObject({ endOk: true, endTitle: "Update done", finalState: { swapped: { "runner-1": "v2" }, failed: { "runner-2": "boom" } } });
    expect(row.endedAt!.toISOString()).toBe(at(1));
    expect(row.endBody).toBe("b".repeat(1000));
  });

  it("creates an ended row for a hold it never saw open", async () => {
    const c = (ctx = await setup());
    await c.history.close(at(2), { ok: false, title: "Never recorded", body: "b" });
    const all = await rows(c);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "update", reason: "", endOk: false, endTitle: "Never recorded" });
    expect(all[0]!.startedAt.toISOString()).toBe(at(2));
    expect(all[0]!.endedAt!.toISOString()).toBe(at());
  });

  it("prunes rows older than 90 days and keeps the rest", async () => {
    const c = (ctx = await setup());
    const old = new Date(T0.getTime() - 91 * DAY).toISOString();
    const justInside = new Date(T0.getTime() - 89 * DAY).toISOString();
    await c.history.upsert(hold({ since: old }));
    await c.history.upsert(hold({ since: justInside }));
    await c.history.upsert(hold());
    await c.history.close(at(), { ok: true, title: "done", body: "b" });
    const started = (await rows(c)).map((r) => r.startedAt.toISOString()).sort();
    expect(started).toEqual([justInside, at()].sort());
  });
});

describe("closeOrphans", () => {
  it("ends every open row as lost, and leaves ended rows untouched", async () => {
    const c = (ctx = await setup());
    await c.history.upsert(hold({ since: at() }));
    await c.history.upsert(hold({ since: at(1) }));
    await c.history.upsert(hold({ since: at(2) }));
    await c.history.close(at(2), { ok: true, title: "Ended cleanly", body: "b" });
    c.clock.now = new Date(T0.getTime() + 5 * MIN);
    await c.history.closeOrphans();
    const bySince = new Map((await rows(c)).map((r) => [r.startedAt.toISOString(), r]));
    for (const since of [at(), at(1)]) {
      expect(bySince.get(since)).toMatchObject({ endOk: false, endTitle: LOST_TITLE });
      expect(bySince.get(since)!.endedAt!.toISOString()).toBe(c.clock.now.toISOString());
    }
    expect(bySince.get(at(2))).toMatchObject({ endOk: true, endTitle: "Ended cleanly" });
    expect(bySince.get(at(2))!.endedAt!.toISOString()).toBe(at());
  });
});

describe("list", () => {
  it("lists newest first and holds the limit between 1 and 100", async () => {
    const c = (ctx = await setup());
    await c.db.insert(updateHolds).values(
      Array.from({ length: 105 }, (_, i) => ({ startedAt: new Date(T0.getTime() + i * MIN), kind: "update", reason: `r${i}`, deadline: null, minutes: 1 })),
    );
    const newest = at(104);
    const list = await c.history.list();
    expect(list).toHaveLength(20);
    expect(list[0]!.startedAt.toISOString()).toBe(newest);
    expect(list.every((r, i) => i === 0 || r.startedAt < list[i - 1]!.startedAt)).toBe(true);

    const smallest = await c.history.list(0);
    expect(smallest).toHaveLength(1);
    expect(smallest[0]!.startedAt.toISOString()).toBe(newest);

    expect(await c.history.list(1000)).toHaveLength(100);
  });
});

describe("a failing write", () => {
  it("logs what failed and does not throw", async () => {
    const raw = await openPglite(undefined, { fresh: true });
    const logs: string[] = [];
    const history = updateHoldHistory(raw.db, () => T0, (m) => logs.push(m));
    await raw.close();
    await expect(history.upsert(hold())).resolves.toBeUndefined();
    await expect(history.event(at(), "x")).resolves.toBeUndefined();
    expect(logs).toContainEqual(expect.stringContaining("update hold record (save) failed"));
    expect(logs).toContainEqual(expect.stringContaining("update hold record (event) failed"));
  });
});
