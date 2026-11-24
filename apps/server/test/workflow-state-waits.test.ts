// BOS-2425: "Where tickets wait" on the Workflow report: each finished ticket's time per state, Review split into
// being checked, in review and merging by its review slots, then the medians and the 5 slowest.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { reviewRequests, ticketTransitions, tickets } from "../src/db/schema.js";
import { timeInStates, whereTicketsWait, workflowService } from "../src/services/workflow.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

const H = 3_600_000;
const D = 24 * H;
const NOW = new Date("2026-10-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
/** [from, to, hours ago] steps. */
const walk = (...steps: [string | null, string, number][]) => steps.map(([fromState, toState, h]) => ({ fromState, toState, at: ago(h * H) }));
const slot = (status: string, openedH: number, decidedH: number | null) => ({ status, createdAt: ago(openedH * H), decidedAt: decidedH === null ? null : ago(decidedH * H) });
const zero = { in_progress: 0, checking: 0, in_review: 0, blocked: 0, merging: 0 };

describe("timeInStates", () => {
  it("splits a review stay into being checked, in review and merging", () => {
    const moves = walk([null, "backlog", 30], ["backlog", "in_progress", 20], ["in_progress", "review", 10], ["review", "done", 2]);
    // The check passed after 1h (slots open), the last verdict came 5h later, then 3h in the merge line.
    expect(timeInStates(moves, [slot("approved", 9, 5), slot("approved", 9, 4)])).toEqual({ ...zero, in_progress: 10 * H, checking: 1 * H, in_review: 5 * H, merging: 2 * H });
  });

  it("counts a failed check as checking and a send-back as in review, and adds up every stay", () => {
    const moves = walk(
      [null, "ready", 40],
      ["ready", "in_progress", 30],
      ["in_progress", "review", 28], // check fails: no slot opens
      ["review", "in_progress", 27],
      ["in_progress", "blocked", 25],
      ["blocked", "in_progress", 20],
      ["in_progress", "review", 18], // check passes at 17, changes asked at 15, back to work at 14
      ["review", "in_progress", 14],
      ["in_progress", "review", 12], // re-check 1h, approved at 9, done at 8
      ["review", "done", 8],
    );
    const out = timeInStates(moves, [slot("changes_requested", 17, 15), slot("approved", 11, 9), slot("skipped", 11, null)]);
    expect(out).toEqual({ in_progress: 2 * H + 2 * H + 2 * H + 2 * H, checking: 1 * H + 1 * H + 1 * H, in_review: 3 * H + 2 * H, blocked: 5 * H, merging: 1 * H });
  });

  it("counts a review stay with no reviewers that ended in done as merging", () => {
    expect(timeInStates(walk([null, "in_progress", 5], ["in_progress", "review", 3], ["review", "done", 1]), [])).toEqual({ ...zero, in_progress: 2 * H, merging: 2 * H });
  });

  it("leaves out tickets whose history began before the log", () => {
    // First recorded move leaves review: it was started before transitions existed.
    expect(timeInStates(walk(["review", "in_progress", 5], ["in_progress", "done", 1]), [])).toBeNull();
    // Never started, or never finished in the log.
    expect(timeInStates(walk(["backlog", "done", 1]), [])).toBeNull();
    expect(timeInStates(walk([null, "in_progress", 5]), [])).toBeNull();
    expect(timeInStates([], [])).toBeNull();
  });

  it("ignores time in Ready or Backlog after the start", () => {
    const moves = walk([null, "in_progress", 10], ["in_progress", "ready", 8], ["ready", "in_progress", 3], ["in_progress", "done", 1]);
    expect(timeInStates(moves, [])).toEqual({ ...zero, in_progress: 4 * H });
  });
});

describe("whereTicketsWait", () => {
  it("gives medians of tickets that spent time in a state, shares of all time, and the 5 slowest", () => {
    const timed = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, ref: `X-${i}`, title: `T${i}`, times: { ...zero, in_progress: (i + 1) * H, blocked: i === 6 ? 20 * H : 0 } }));
    const { rows, slowest } = whereTicketsWait(timed);
    const ip = rows.find((r) => r.state === "in_progress")!;
    expect(ip).toMatchObject({ tickets: 7, p50Ms: 4 * H });
    expect(ip.share).toBeCloseTo(28 / 48);
    expect(rows.find((r) => r.state === "blocked")).toMatchObject({ tickets: 1, p50Ms: 20 * H, p90Ms: 20 * H });
    expect(rows.find((r) => r.state === "checking")).toMatchObject({ tickets: 0, p50Ms: null, share: 0 });
    expect(slowest.map((s) => s.ref)).toEqual(["X-6", "X-5", "X-4", "X-3", "X-2"]);
    expect(slowest[0]).toMatchObject({ totalMs: 27 * H, longest: "blocked", longestMs: 20 * H });
  });

  it("is empty with nothing timed", () => {
    const { rows, slowest } = whereTicketsWait([]);
    expect(rows.every((r) => r.tickets === 0 && r.share === null)).toBe(true);
    expect(slowest).toEqual([]);
  });
});

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("scorecard stateWaits", () => {
  it("times tickets finished in the period, counts those left out, and skips cancelled and older ones", async () => {
    t = await makeApp();
    const { cookie } = await signIn(t);
    const req = (method: "GET" | "POST", url: string, payload?: object) => t!.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
    const { company } = (await req("POST", "/api/companies", { name: "Waits Co" })).json() as { company: { id: string } };
    const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Notes" })).json() as { id: string };
    const db = t.db;
    const ticket = async (steps: [string, number][], patch: Partial<typeof tickets.$inferInsert> = {}) => {
      const [first, ...rest] = steps;
      const [row] = await db.insert(tickets).values({ companyId: company.id, projectId: project.id, title: "Task", systemState: first![0] as "backlog", stateChangedAt: ago(first![1]), ...patch }).returning();
      for (const [state, at] of rest) await db.update(tickets).set({ systemState: state as "done", stateChangedAt: ago(at) }).where(eq(tickets.id, row!.id));
      return row!;
    };
    const slow = await ticket([["backlog", 5 * D], ["in_progress", 4 * D], ["review", 2 * D], ["done", 1 * D]], { title: "Slow one" });
    await db.insert(reviewRequests).values({ ticketId: slow.id, kind: "code", round: 1, status: "approved", createdAt: ago(2 * D - H), decidedAt: ago(1 * D + H) });
    await ticket([["backlog", 3 * D], ["in_progress", 3 * D - 2 * H], ["done", 3 * D - 3 * H]], { title: "Quick one" });
    // Finished in the period but its history was lost: left out and counted.
    const old = await ticket([["backlog", 6 * D], ["in_progress", 5 * D], ["done", 2 * D]]);
    await db.delete(ticketTransitions).where(eq(ticketTransitions.ticketId, old.id));
    // Cancelled, and finished before the period: neither counts at all.
    await ticket([["in_progress", 4 * D], ["done", 1 * D]], { outcome: "cancelled" });
    await ticket([["in_progress", 30 * D], ["done", 20 * D]]);

    const sc = await workflowService(db, { now: () => NOW }).scorecard(company.id, 14);
    expect(sc.stateWaits.timed).toBe(2);
    expect(sc.stateWaits.leftOut).toBe(1);
    expect(sc.stateWaits.slowest.map((s) => s.title)).toEqual(["Slow one", "Quick one"]);
    expect(sc.stateWaits.slowest[0]).toMatchObject({ totalMs: 3 * D, longest: "in_progress", longestMs: 2 * D });
    expect(sc.stateWaits.rows.find((r) => r.state === "checking")).toMatchObject({ tickets: 1, p50Ms: H });
    expect(sc.stateWaits.rows.find((r) => r.state === "in_review")).toMatchObject({ tickets: 1, p50Ms: 22 * H });
    expect(sc.stateWaits.rows.find((r) => r.state === "merging")).toMatchObject({ tickets: 1, p50Ms: H });
    // The route passes it through unchanged.
    const res = await req("GET", `/api/companies/${company.id}/workflow?days=14`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { stateWaits?: { rows: unknown[] } }).stateWaits?.rows).toHaveLength(5);
  });
});
