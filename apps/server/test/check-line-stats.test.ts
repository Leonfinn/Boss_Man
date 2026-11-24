// BOS-2436: the check line over 7 days, all machines together, from check_jobs.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs } from "../src/db/schema.js";
import { checkLineStats, lineKindOf } from "../src/services/check-line-stats.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "GET", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Work" })).json() as { id: string };
  let n = 0;
  /** A job queued at `queuedAt`, started `waitMin` later and running `runMin`; null leaves that time unset. */
  const job = (o: { kind?: string; scope?: string; state: string; queuedAt: Date; waitMin: number | null; runMin: number | null; companyId?: string; projectId?: string; ticketId?: string }) => {
    const startedAt = o.waitMin === null ? null : new Date(o.queuedAt.getTime() + o.waitMin * 60_000);
    const endedAt = startedAt && o.runMin !== null ? new Date(startedAt.getTime() + o.runMin * 60_000) : null;
    return db.insert(checkJobs).values({
      companyId: o.companyId ?? company.id,
      projectId: o.projectId ?? project.id,
      ticketId: o.ticketId ?? ticket.id,
      kind: o.kind ?? "pre_review",
      scope: o.scope ?? "quick",
      state: o.state,
      commit: String(++n).padStart(40, "a"),
      tree: String(n).padStart(40, "a"),
      queuedAt: o.queuedAt,
      startedAt,
      endedAt,
    } as never);
  };
  return { ...built, db, close, req, company, project, ticket, job };
}

describe("lineKindOf", () => {
  it("names a merge job merge and an author's job by its scope", () => {
    expect(lineKindOf("merge", "full")).toBe("merge");
    expect(lineKindOf("pre_review", "full")).toBe("full");
    expect(lineKindOf("pre_review", "quick")).toBe("quick");
  });
});

describe("checkLineStats", () => {
  it("counts per day and kind, with waits, run times, busiest hours and what waits now", async () => {
    const c = (ctx = await setup());
    const now = new Date("2026-11-23T12:00:00Z");
    const at = (iso: string) => new Date(iso);
    // Quick checks: waits 10, 20, 60 min; runs 5, 5, 7 min. Two at 09:xx UTC, one at 10:xx.
    await c.job({ state: "passed", queuedAt: at("2026-11-23T09:00:00Z"), waitMin: 10, runMin: 5 });
    await c.job({ state: "failed", queuedAt: at("2026-11-23T09:30:00Z"), waitMin: 20, runMin: 5 });
    await c.job({ state: "passed", queuedAt: at("2026-11-22T10:00:00Z"), waitMin: 60, runMin: 7 });
    // Merge: one ran (wait 30, run 40), one still running (wait 90, no run time yet).
    await c.job({ kind: "merge", scope: "full", state: "passed", queuedAt: at("2026-11-21T09:15:00Z"), waitMin: 30, runMin: 40 });
    await c.job({ kind: "merge", scope: "full", state: "running", queuedAt: at("2026-11-23T08:00:00Z"), waitMin: 90, runMin: null });
    // A full check that waits now (counts in its day and "waiting now", not in the medians), and one cancelled.
    await c.job({ scope: "full", state: "queued", queuedAt: at("2026-11-23T11:00:00Z"), waitMin: null, runMin: null });
    await c.job({ scope: "full", state: "cancelled", queuedAt: at("2026-11-23T11:10:00Z"), waitMin: 5, runMin: 1 });
    // Queued 9 days ago and still waiting: only in "waiting now", and the oldest wait.
    await c.job({ state: "queued", queuedAt: at("2026-11-14T12:00:00Z"), waitMin: null, runMin: null });
    // Ended 8 days ago: left out.
    await c.job({ state: "passed", queuedAt: at("2026-11-15T09:00:00Z"), waitMin: 1, runMin: 1 });

    const s = await checkLineStats(c.db, { now, timeZone: "UTC" });
    expect(s.days.map((d) => d.date)).toEqual(["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"]);
    expect(s.days[6]).toEqual({ date: "2026-11-23", quick: 2, full: 1, merge: 1 });
    expect(s.days[5]).toEqual({ date: "2026-11-22", quick: 1, full: 0, merge: 0 });
    expect(s.days[4]).toEqual({ date: "2026-11-21", quick: 0, full: 0, merge: 1 });
    const kind = (k: string) => s.kinds.find((x) => x.kind === k)!;
    expect(kind("quick")).toEqual({ kind: "quick", total: 3, cancelled: 0, medianWaitSeconds: 1200, longestWaitSeconds: 3600, medianRunSeconds: 300 });
    expect(kind("merge")).toEqual({ kind: "merge", total: 2, cancelled: 0, medianWaitSeconds: 3600, longestWaitSeconds: 5400, medianRunSeconds: 2400 });
    expect(kind("full")).toEqual({ kind: "full", total: 1, cancelled: 1, medianWaitSeconds: null, longestWaitSeconds: null, medianRunSeconds: null });
    // 09:xx has three (09:00, 09:30, 09:15), then 08, 10 and 11 one each: ties go to the earlier hour.
    expect(s.busiestHours).toEqual([
      { hour: 9, checks: 3 },
      { hour: 8, checks: 1 },
      { hour: 10, checks: 1 },
    ]);
    expect(s.waitingNow).toBe(2);
    expect(s.oldestWaitSeconds).toBe(9 * 86_400);
  });

  it("puts days and hours in the asked zone, and falls back to UTC for a bad one", async () => {
    const c = (ctx = await setup());
    const now = new Date("2026-11-23T12:00:00Z");
    // 23:30 UTC on the 22nd is 08:30 on the 23rd in Tokyo.
    await c.job({ state: "passed", queuedAt: new Date("2026-11-22T23:30:00Z"), waitMin: 1, runMin: 1 });
    const tokyo = await checkLineStats(c.db, { now, timeZone: "Asia/Tokyo" });
    expect(tokyo.timeZone).toBe("Asia/Tokyo");
    expect(tokyo.days.at(-1)!.date).toBe("2026-11-23");
    expect(tokyo.days.at(-1)!.quick).toBe(1);
    expect(tokyo.busiestHours).toEqual([{ hour: 8, checks: 1 }]);
    const bad = await checkLineStats(c.db, { now, timeZone: "Not/AZone" });
    expect(bad.timeZone).toBe("UTC");
    expect(bad.busiestHours).toEqual([{ hour: 23, checks: 1 }]);
    expect(bad.days.find((d) => d.date === "2026-11-22")!.quick).toBe(1);
  });

  it("counts only the asked company's jobs, at the owner route, refused without a session", async () => {
    const c = (ctx = await setup());
    const other = (await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    const op = (await c.req("POST", `/api/companies/${other.company.id}/projects`, { name: "Other app" })).json() as { id: string };
    const ot = (await c.req("POST", `/api/projects/${op.id}/tickets`, { title: "Theirs" })).json() as { id: string };
    const recent = new Date(Date.now() - 3_600_000);
    await c.job({ state: "passed", queuedAt: recent, waitMin: 1, runMin: 1 });
    await c.job({ state: "queued", queuedAt: recent, waitMin: null, runMin: null, companyId: other.company.id, projectId: op.id, ticketId: ot.id });

    expect((await c.app.inject({ method: "GET", url: "/api/settings/check-workers/line" })).statusCode).toBe(401);
    const all = (await c.req("GET", "/api/settings/check-workers/line?tz=Europe%2FLondon")).json() as { kinds: { total: number }[]; waitingNow: number; timeZone: string };
    expect(all.timeZone).toBe("Europe/London");
    expect(all.kinds.reduce((t, k) => t + k.total, 0)).toBe(2);
    expect(all.waitingNow).toBe(1);
    const mine = (await c.req("GET", `/api/settings/check-workers/line?companyId=${c.company.id}`)).json() as { kinds: { total: number }[]; waitingNow: number };
    expect(mine.kinds.reduce((t, k) => t + k.total, 0)).toBe(1);
    expect(mine.waitingNow).toBe(0);
  });
});
