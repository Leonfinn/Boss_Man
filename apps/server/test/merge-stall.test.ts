// The merge line reports its own stops (BOS-1515): the train's held-alone and stall facts (pure, fake clock), the stall alarm
// (CEO once per stall, the owner once 15 minutes later, read again when it clears), and a replay of the 14 Nov jam.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, notifications, settings } from "../src/db/schema.js";
import { MergeTrain } from "../src/services/merge-train.js";
import { EMPTY_SEAT_MS, MERGE_STALL_REASON, mergeStallService, mergeTrainStatus, NO_LANDING_MS, stalls } from "../src/services/merge-stall.js";
import { OWNER_AFTER_MS } from "../src/services/priority-watch.js";
import { WAKE_CLASS } from "../src/services/wake-classes.js";
import { NOV14_GAP, NOV14_ROWS, NOV14_SCRIPT, at } from "./fixtures/merge-line-14-nov.js";

const MIN = 60_000;
const SEC = 1000;

describe("merge train: held-alone and stall facts (BOS-1515)", () => {
  it("a ticket held to land alone carries its clash, and is listed with how many have passed it", () => {
    const clock = { t: 0 };
    const tr = new MergeTrain({ seats: () => 2, now: () => clock.t });
    tr.join("a", { priority: 1, place: 1 });
    expect(tr.seated("a")).toBe(true);
    tr.join("h", { priority: 1, place: 2, headOnly: true, clash: { with: ["a"], files: ["src/x.ts"], at: 5 } });
    tr.join("y", { priority: 1, place: 3 });
    expect(tr.seated("y")).toBe(true);
    expect(tr.heldAlone()).toEqual([{ ticketId: "h", clash: { with: ["a"], files: ["src/x.ts"], at: 5 }, passed: 1, holdsLine: false }]);
    expect(tr.clashOf("h")).toEqual({ with: ["a"], files: ["src/x.ts"], at: 5 });
    tr.landed("a");
    tr.join("z", { priority: 1, place: 4 });
    expect(tr.seated("z")).toBe(true);
    expect(tr.heldAlone()[0]).toMatchObject({ passed: 2, holdsLine: true });
  });

  it("an empty seat counts only while a ticket that could take it waits, never for a lone head-only ticket or the seed wait", () => {
    const clock = { t: 1000 };
    const tr = new MergeTrain({ seats: () => 2, now: () => clock.t });
    tr.join("a", { priority: 1, place: 1 });
    tr.seated("a");
    // A head-only ticket alone, waiting for a to land: that is the design, not a stall.
    tr.join("h", { priority: 1, place: 2, headOnly: true });
    tr.seated("h");
    expect(tr.facts().emptySeatSince).toBeNull();
    // It has been passed twice (seats = 2) and now holds the line: w waits behind it while a seat is free.
    for (const id of ["y", "z"]) {
      tr.join(id, { priority: 1, place: 3 });
      tr.seated(id);
      tr.landed(id);
    }
    clock.t = 2000;
    tr.join("w", { priority: 1, place: 9 });
    expect(tr.seated("w")).toBe(false);
    expect(tr.facts()).toMatchObject({ emptySeatSince: 2000, seated: ["a"], waiting: ["h", "w"] });
    clock.t = 2000 + EMPTY_SEAT_MS;
    expect(stalls(tr.facts(), clock.t)).toEqual([{ cause: "empty_seat", since: 2000 }]);
    // a lands: h is seated as the head, w beside it: no empty seat.
    tr.landed("a");
    tr.seated("h");
    expect(tr.facts().emptySeatSince).toBeNull();

    const seeded = new MergeTrain({ seats: () => 2, now: () => clock.t });
    seeded.seedOrder(["old"]);
    seeded.join("n", { priority: 1, place: 1 });
    expect(seeded.seated("n")).toBe(false);
    expect(seeded.facts()).toMatchObject({ seeding: true, emptySeatSince: null });
  });

  it("no landing is timed from the later of the last landing and the line getting busy, and only while tickets are in it", () => {
    const clock = { t: 0 };
    const tr = new MergeTrain({ seats: () => 1, now: () => clock.t });
    expect(tr.facts().noLandingSince).toBeNull();
    clock.t = 100;
    tr.join("a", { priority: 1, place: 1 });
    tr.seated("a");
    expect(tr.facts()).toMatchObject({ noLandingSince: 100, lastLandingAt: null });
    clock.t = 500;
    tr.join("b", { priority: 1, place: 2 });
    tr.landed("a");
    expect(tr.facts()).toMatchObject({ noLandingSince: 500, lastLandingAt: 500 });
    clock.t = 900;
    tr.seated("b");
    tr.landed("b");
    expect(tr.facts().noLandingSince).toBeNull();
    // Busy again later: timed from then, not from the old landing.
    clock.t = 5000;
    tr.join("c", { priority: 1, place: 3 });
    expect(tr.facts().noLandingSince).toBe(5000);
  });

  it("the thresholds: no alarm at 2:59 or 44:59, one at 3:00 and 45:00", () => {
    const base = { seats: 2, seated: ["a"], waiting: ["b"], heldAlone: [], lastLandingAt: null, seeding: false, thrashSince: null };
    expect(stalls({ ...base, emptySeatSince: 0, noLandingSince: null }, EMPTY_SEAT_MS - SEC)).toEqual([]);
    expect(stalls({ ...base, emptySeatSince: 0, noLandingSince: null }, EMPTY_SEAT_MS)).toEqual([{ cause: "empty_seat", since: 0 }]);
    expect(stalls({ ...base, emptySeatSince: null, noLandingSince: 0 }, NO_LANDING_MS - SEC)).toEqual([]);
    expect(stalls({ ...base, emptySeatSince: null, noLandingSince: 0 }, NO_LANDING_MS)).toEqual([{ cause: "no_landing", since: 0 }]);
    // The seed wait after a restart is never an empty-seat stall.
    expect(stalls({ ...base, seeding: true, emptySeatSince: 0, noLandingSince: null }, EMPTY_SEAT_MS)).toEqual([]);
  });

  it("a restack loop (BOS-1604) is a stall at once, with no 45-minute wait", () => {
    const base = { seats: 2, seated: ["a"], waiting: [], heldAlone: [], lastLandingAt: null, seeding: false, emptySeatSince: null, noLandingSince: 0 };
    expect(stalls({ ...base, thrashSince: null }, SEC)).toEqual([]);
    expect(stalls({ ...base, thrashSince: 0 }, SEC)).toEqual([{ cause: "thrash", since: 0 }]);
  });

  it("its wake reason is a waiting-class wake (never dropped)", () => {
    expect(WAKE_CLASS[MERGE_STALL_REASON]).toBe("waiting");
  });
});

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.close();
});
beforeEach(async () => {
  await ctx.db.delete(settings).where(sql`${settings.key} like 'merge_stall:%'`);
  ctx.told.length = 0;
  ctx.sent.length = 0;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  // One real ticket per letter of the 14 Nov fixture, so the alarm names them by ref.
  const ids = new Map<string, string>();
  const refs = new Map<string, string>();
  for (const who of [...new Set([...NOV14_ROWS.map((r) => r.who), "a", "b", "h"])]) {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Ticket ${who}` })).json() as { id: string; number: number };
    ids.set(who, t.id);
    refs.set(who, `${(await db.select({ p: companies.ticketPrefix }).from(companies).where(eq(companies.id, company.id)))[0]!.p}-${t.number}`);
  }
  const told: Array<{ ticketId: string; note: string; at: number }> = [];
  const sent: Array<{ id: string; title: string; body: string; at: number }> = [];
  const service = (clock: { t: number }, trains: () => Array<{ projectId: string; facts: ReturnType<MergeTrain["facts"]> }>) =>
    mergeStallService(db, {
      tellCeo: async ({ ticketId, note }) => void told.push({ ticketId, note, at: clock.t }),
      notify: async (input) => {
        const row = await built.notes.notify(input);
        if (row) sent.push({ id: row.id, title: input.title, body: input.body, at: clock.t });
        return row;
      },
      now: () => new Date(clock.t),
      trains,
    });
  return { ...built, db, close, company, project, ids, refs, told, sent, service };
}

describe("merge stall alarm (BOS-1515)", () => {
  it("tells the CEO once per stall, the owner once 15 minutes later, reads the owner's notification when it clears, and alarms again on a new stall", async () => {
    const clock = { t: at("12:00:00") };
    const tr = new MergeTrain({ seats: () => 2, now: () => clock.t });
    const id = (w: string) => ctx.ids.get(w)!;
    tr.join(id("a"), { priority: 1, place: 1 });
    tr.seated(id("a"));
    tr.join(id("h"), { priority: 1, place: 2, headOnly: true, clash: { with: [id("a")], files: ["src/a.ts", "src/b.ts"], at: clock.t } });
    // Two tickets pass h, so it holds the line; b then waits while a seat is free.
    for (const w of ["E", "F"]) {
      tr.join(id(w), { priority: 1, place: 3 });
      tr.seated(id(w));
      tr.landed(id(w));
    }
    tr.join(id("b"), { priority: 1, place: 9 });
    tr.seated(id("b"));
    const svc = ctx.service(clock, () => [{ projectId: ctx.project.id, facts: tr.facts() }]);

    clock.t += EMPTY_SEAT_MS - SEC;
    expect(await svc.run()).toMatchObject({ told: 0 });
    clock.t += SEC;
    expect(await svc.run()).toMatchObject({ told: 1, ownerTold: 0 });
    expect(ctx.told).toHaveLength(1);
    expect(ctx.told[0]!.ticketId).toBe(id("h"));
    const note = ctx.told[0]!.note;
    expect(note).toContain("a merge-train seat has been empty for");
    expect(note).toContain("2 seats");
    // The cause, with the ticket h clashed with and the files.
    expect(note).toContain(`${ctx.refs.get("h")} is held to land on main alone: it clashed with ${ctx.refs.get("a")} in 2 files (src/a.ts, src/b.ts), and 2 tickets have passed it`);

    clock.t += 5 * MIN;
    expect(await svc.run()).toMatchObject({ told: 0, ownerTold: 0 });
    clock.t += OWNER_AFTER_MS - 5 * MIN;
    expect(await svc.run()).toMatchObject({ ownerTold: 1 });
    clock.t += MIN;
    expect(await svc.run()).toMatchObject({ ownerTold: 0, told: 0 });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.title).toBe("The merge line has an empty seat it isn't using");
    expect(ctx.sent[0]!.body).toContain("The CEO was told 15 minutes ago");

    // a lands: h is seated, the stall clears, the owner's notification is read.
    tr.landed(id("a"));
    tr.seated(id("h"));
    expect(await svc.run()).toMatchObject({ cleared: 1 });
    const [n] = await ctx.db.select().from(notifications).where(eq(notifications.id, ctx.sent[0]!.id));
    expect(n!.readAt).not.toBeNull();

    // A new stall later is a new episode: told again.
    expect(tr.seatedIds()).toEqual([id("h"), id("b")]);
    tr.join(id("C"), { priority: 1, place: 20, headOnly: true });
    tr.landed(id("b"));
    for (const w of ["D", "L"]) {
      tr.join(id(w), { priority: 1, place: 21 });
      tr.seated(id(w));
      tr.landed(id(w));
    }
    tr.join(id("B"), { priority: 1, place: 30 });
    tr.seated(id("B"));
    expect(tr.facts().emptySeatSince).not.toBeNull();
    clock.t += EMPTY_SEAT_MS;
    expect(await svc.run()).toMatchObject({ told: 1 });
  });

  it("no landing for 45 minutes names the running check, so a long check reads as one", async () => {
    const clock = { t: at("12:00:00") };
    const tr = new MergeTrain({ seats: () => 1, now: () => clock.t });
    tr.join(ctx.ids.get("S")!, { priority: 1, place: 1 });
    tr.seated(ctx.ids.get("S")!);
    tr.join(ctx.ids.get("B")!, { priority: 1, place: 2 });
    const svc = ctx.service(clock, () => [{ projectId: ctx.project.id, facts: tr.facts() }]);
    clock.t += NO_LANDING_MS - SEC;
    expect(await svc.run()).toMatchObject({ told: 0 });
    clock.t += SEC;
    expect(await svc.run()).toMatchObject({ told: 1 });
    expect(ctx.told[0]!.note).toContain("nothing has landed for 45 minutes");
    expect(ctx.told[0]!.note).toContain("No merge check is running.");
  });

  it("a stall whose train is gone (a restart) is cleared, never left standing", async () => {
    const clock = { t: at("12:00:00") };
    const tr = new MergeTrain({ seats: () => 1, now: () => clock.t });
    tr.join(ctx.ids.get("S")!, { priority: 1, place: 1 });
    tr.seated(ctx.ids.get("S")!);
    let live = true;
    const svc = ctx.service(clock, () => (live ? [{ projectId: ctx.project.id, facts: tr.facts() }] : []));
    clock.t += NO_LANDING_MS;
    expect(await svc.run()).toMatchObject({ told: 1 });
    live = false;
    expect(await svc.run()).toMatchObject({ cleared: 1, told: 0 });
    expect(await ctx.db.select().from(settings).where(sql`${settings.key} like 'merge_stall:%'`)).toEqual([]);
  });

  it("server_status mergeTrain shows the held-alone ticket by ref with its clash and files", async () => {
    const tr = new MergeTrain({ seats: () => 2 });
    const id = (w: string) => ctx.ids.get(w)!;
    tr.join(id("L"), { priority: 1, place: 1 });
    tr.seated(id("L"));
    tr.join(id("P1"), { priority: 1, place: 2, headOnly: true, clash: { with: [id("L")], files: ["src/x.ts"], at: at("20:14:35") } });
    const [p] = await mergeTrainStatus(ctx.db, ctx.company.id, (pid) => (pid === ctx.project.id ? tr.facts() : null));
    expect(p).toMatchObject({ project: "Site", seats: 2, heldAlone: [{ ticketId: id("P1"), clashWith: [ctx.refs.get("L")], files: ["src/x.ts"], since: "2026-11-14T20:14:35.000Z", passed: 0, holdsLine: false }] });
    expect(p!.seated).toHaveLength(1);
    expect(p!.waiting).toHaveLength(1);
  });
});

/**
 * Replays NOV14_SCRIPT against a real train on the 14 Nov clock, running the alarm every 15 s (the sweep runs every 60 s; finer
 * steps keep the assertions on the threshold, not on the sweep's phase). `trial`: P1 is sent back when L lands (B2).
 */
async function replay(trial: boolean) {
  const s = NOV14_SCRIPT;
  const clock = { t: s.start };
  const tr = new MergeTrain({ seats: () => s.seats(clock.t), now: () => clock.t });
  const id = (w: string) => ctx.ids.get(w)!;
  const joined = new Set<string>();
  const svc = ctx.service(clock, () => [{ projectId: ctx.project.id, facts: tr.facts() }]);
  type Step = { at: number; run: () => void };
  const steps: Step[] = [
    ...s.joins.map((j) => ({ at: j.at, run: () => (tr.join(id(j.who), { priority: j.priority, place: j.place }), joined.add(j.who)) })),
    ...s.lands.map((l) => ({ at: l.at, run: () => tr.landed(id(l.who)) })),
    {
      at: s.heldAloneAt,
      run: () => {
        tr.leave(id("P1"));
        tr.join(id("P1"), { priority: 1, place: at("19:09:51"), headOnly: true, clash: { with: [id("L")], files: ["apps/server/src/services/check-queue.ts", "apps/server/src/services/review.ts"], at: clock.t } });
      },
    },
    { at: trial ? s.p1SentBackByTrial + 1 : s.p1Left, run: () => tr.leave(id("P1")) },
  ].sort((a, b) => a.at - b.at);
  const seatedAt = new Map<string, number>();
  // Every waiting landing polls its seat (every 3 s in the real loop); here after each step and each tick.
  const poll = () => {
    for (const w of joined) if (tr.seated(id(w)) && !seatedAt.has(w)) seatedAt.set(w, clock.t);
  };
  const empties: number[] = [];
  for (let t = s.start; t <= s.end; t += 15 * SEC) {
    while (steps.length && steps[0]!.at <= t) {
      const step = steps.shift()!;
      clock.t = step.at;
      step.run();
      poll();
    }
    clock.t = t;
    poll();
    if (tr.facts().emptySeatSince !== null) empties.push(t);
    await svc.run();
  }
  return { seatedAt, empties, told: [...ctx.told], sent: [...ctx.sent] };
}

describe("14 Nov replay (BOS-1511)", () => {
  it("without the trial on main: B, C and D pass P1, the seats freed at 20:30:45 and 20:38:00 stay empty, and the CEO hears by 20:33:45", async () => {
    const r = await replay(false);
    // The train seats what the rows show: B and C past P1 at 20:14, D when L lands, E and F only once the train ahead drained.
    expect(r.seatedAt.get("B")).toBeLessThan(at("20:15:00"));
    expect(r.seatedAt.get("C")).toBeLessThan(at("20:15:00"));
    expect(r.seatedAt.get("D")).toBe(NOV14_SCRIPT.lands[0]!.at);
    const dLanded = NOV14_SCRIPT.lands[3]!.at;
    expect(r.seatedAt.get("E")).toBe(dLanded);
    expect(r.seatedAt.get("F")).toBe(dLanded);
    // Empty with E and F waiting from B's landing until P1 left.
    expect(r.empties[0]).toBeGreaterThanOrEqual(NOV14_SCRIPT.emptySeats[0]!);
    expect(r.empties.at(-1)).toBeLessThan(dLanded);
    const empty = r.told.filter((t) => t.note.includes("seat has been empty"));
    expect(empty).toHaveLength(1);
    expect(empty[0]!.at).toBeGreaterThanOrEqual(NOV14_SCRIPT.emptySeats[0]! + EMPTY_SEAT_MS);
    expect(empty[0]!.at).toBeLessThanOrEqual(at("20:33:45") + 15 * SEC);
    expect(empty[0]!.ticketId).toBe(ctx.ids.get("P1"));
    expect(empty[0]!.note).toContain("in 2 files (apps/server/src/services/check-queue.ts, apps/server/src/services/review.ts)");
    expect(empty[0]!.note).toContain("3 tickets have passed it");
    // Still empty 15 minutes after the CEO was told: the owner hears once.
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.at).toBeGreaterThanOrEqual(empty[0]!.at + OWNER_AFTER_MS);
  });

  it("with the trial on main: P1 goes back when L lands at 20:22:55, no seat stays empty, and nobody is alarmed", async () => {
    const r = await replay(true);
    expect(r.empties).toEqual([]);
    expect(r.told.filter((t) => t.note.includes("seat has been empty"))).toEqual([]);
    // E is seated when B lands (20:30:45), F when C lands, instead of at 21:08.
    expect(r.seatedAt.get("E")).toBe(NOV14_SCRIPT.emptySeats[0]);
    expect(r.seatedAt.get("F")).toBe(NOV14_SCRIPT.emptySeats[1]);
  });

  it("the 50-minute gap with no landing (19:24:30 to 20:14:23) alarms at 20:09:30, not before", async () => {
    const clock = { t: NOV14_GAP.lastLanding - 30 * SEC };
    const tr = new MergeTrain({ seats: () => 1, now: () => clock.t });
    const id = (w: string) => ctx.ids.get(w)!;
    tr.join(id("X0"), { priority: 1, place: 0 });
    tr.seated(id("X0"));
    for (const w of ["S", "P1", "B", "C"]) tr.join(id(w), { priority: 1, place: at("19:00:00") });
    clock.t = NOV14_GAP.lastLanding;
    tr.landed(id("X0"));
    tr.seated(id("S"));
    const svc = ctx.service(clock, () => [{ projectId: ctx.project.id, facts: tr.facts() }]);
    clock.t = at("20:09:29.278");
    expect(await svc.run()).toMatchObject({ told: 0 });
    clock.t = at("20:09:30.278");
    expect(await svc.run()).toMatchObject({ told: 1 });
    expect(ctx.told[0]!.note).toContain("nothing has landed for 45 minutes");
    // The next landing ends it.
    clock.t = NOV14_GAP.nextLanding;
    tr.landed(id("S"));
    expect(await svc.run()).toMatchObject({ cleared: 1 });
  });
});
