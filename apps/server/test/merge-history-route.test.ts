// BOS-2379: GET /api/companies/:id/merge-history, read through the real app on seeded merge-line rows and check jobs.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, checkJobs, tickets } from "../src/db/schema.js";
import type { MergeHistory } from "../src/services/merge-history.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string } };
  const p = (await built.app.inject({ method: "POST", url: `/api/companies/${co.company.id}/projects`, headers: { cookie }, payload: { name: "App" } })).json() as { id: string };
  return { ...built, db, close, cookie, companyId: co.company.id, projectId: p.id };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const DAY = 86_400_000;

describe("merge history route", () => {
  it("lists the last 14 days: results, waits, machine, the bounce's first failing line, per-day median; leaves out a 15-day-old merge", async () => {
    const base = Date.now() - 3 * DAY;
    const ticket = async (title: string) =>
      (await ctx.db.insert(tickets).values({ companyId: ctx.companyId, projectId: ctx.projectId, title, systemState: "ready" }).returning())[0]!;
    const ev = (t: { id: string }, minute: number, detail: Record<string, unknown>, dayShift = 0) =>
      ctx.db.insert(activity).values({ companyId: ctx.companyId, ticketId: t.id, at: new Date(base + dayShift * DAY + minute * 60_000), kind: "merge_line", summary: "x", detail });
    const landed = async (t: { id: string }, shift: number, extra: Record<string, unknown> = {}) => {
      await ev(t, 0, { event: "attempt" }, shift);
      await ev(t, 1, { event: "check_queued" }, shift);
      await ev(t, 6, { event: "check_started", ranOn: "company runner", ...extra }, shift);
      await ev(t, 16, { event: "check_ended", passed: true }, shift);
      await ev(t, 20, { event: "merged" }, shift);
    };
    const a = await ticket("Landed A");
    const b = await ticket("Landed B");
    const c = await ticket("Landed C");
    const d = await ticket("Bounced twice");
    const e = await ticket("Cancelled");
    const old = await ticket("Fifteen days ago");
    await landed(a, 0);
    await landed(b, 0);
    await landed(c, 0);
    await landed(old, -12); // 15 days before now
    await ev(e, 0, { event: "attempt" });
    await ev(e, 4, { event: "left", to: "in_progress" });

    const job = (await ctx.db.insert(checkJobs).values({ companyId: ctx.companyId, projectId: ctx.projectId, ticketId: d.id, kind: "merge", commit: "abc", tree: "def", state: "failed", logTail: "FAIL test/foo.test.ts > does the thing\nAssertionError: nope" }).returning())[0]!;
    await ev(d, 0, { event: "check_queued" }, 0);
    await ev(d, 3, { event: "attempt_failed", reason: "check_failed", jobId: job.id }, 0);
    await ev(d, 5, { event: "attempt" }, 0);
    await ev(d, 10, { event: "attempt_failed", reason: "check_failed", note: "second try failed" }, 0);
    await ev(d, 30, { event: "check_queued" }, 0);
    await ev(d, 34, { event: "check_started", ranOn: "worker-a" }, 0);
    await ev(d, 44, { event: "check_ended", passed: true }, 0);
    await ev(d, 45, { event: "ci_wait_ended", outcome: "passed", waitedMs: 180_000 }, 0);
    await ev(d, 50, { event: "merged" }, 0);

    const res = await ctx.app.inject({ method: "GET", url: `/api/companies/${ctx.companyId}/merge-history`, headers: { cookie: ctx.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MergeHistory;
    // 5 tickets seen in the window; the bouncing one has 3 attempts, so 7 attempts in all, and the 15-day-old merge is not among them.
    expect(body.rows.map((r) => r.title)).not.toContain("Fifteen days ago");
    expect(new Set(body.rows.map((r) => r.title))).toEqual(new Set(["Landed A", "Landed B", "Landed C", "Bounced twice", "Cancelled"]));
    expect(body.rows).toHaveLength(7);

    const first = body.rows.find((r) => r.title === "Landed A")!;
    expect(first).toMatchObject({ result: "landed", slotWaitMs: 5 * 60_000, checkMs: 10 * 60_000, ranOn: "company runner", totalMs: 20 * 60_000 });
    const bounces = body.rows.filter((r) => r.title === "Bounced twice" && r.result === "bounced");
    expect(bounces).toHaveLength(2);
    expect(bounces.map((r) => r.firstFailingLine).sort()).toEqual(["test/foo.test.ts > does the thing", "second try failed"].sort());
    expect(bounces.every((r) => r.bounces === 2)).toBe(true);
    const last = body.rows.find((r) => r.title === "Bounced twice" && r.result === "landed")!;
    expect(last).toMatchObject({ ranOn: "worker-a", ciWaitMs: 180_000 });
    expect(body.rows.find((r) => r.result === "cancelled")!.title).toBe("Cancelled");

    // One day holds all of it: 4 landed (A, B, C: 20 min; D: 50 min from its last attempt start 30 -> 20 min), 2 bounced; median 20 min.
    expect(body.perDay).toHaveLength(1);
    expect(body.perDay[0]).toMatchObject({ landed: 4, bounced: 2, medianMs: 20 * 60_000 });
  });
});
