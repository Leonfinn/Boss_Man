// BOS-2373: per-machine 7-day record of checks, from check_jobs.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, checkWorkers } from "../src/db/schema.js";
import { checkMachineStats } from "../src/services/check-machine-stats.js";

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
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  return { ...built, db, close, req, company, project, ticket, runnerId: reg.runnerId };
}

describe("checkMachineStats", () => {
  it("counts per machine over 7 days, with median, longest and the last 10", async () => {
    const c = (ctx = await setup());
    const [w] = await c.db.insert(checkWorkers).values({ name: "Spare", tokenHash: "x".repeat(10) } as never).returning();
    const now = new Date("2026-11-23T12:00:00Z");
    const mins = (m: number) => new Date(now.getTime() - m * 60_000);
    let n = 0;
    const job = (state: string, lengthMin: number, endedAgoMin: number, worker: boolean) =>
      c.db.insert(checkJobs).values({
        companyId: c.company.id,
        projectId: c.project.id,
        ticketId: c.ticket.id,
        kind: "pre_review",
        scope: "quick",
        state,
        commit: String(++n).padStart(40, "a"),
        tree: String(n).padStart(40, "a"),
        runnerId: worker ? null : c.runnerId,
        workerId: worker ? w!.id : null,
        startedAt: mins(endedAgoMin + lengthMin),
        endedAt: mins(endedAgoMin),
      } as never);
    await job("passed", 10, 5, false);
    await job("failed", 20, 10, false);
    await job("passed", 30, 15, false);
    await job("stuck", 5, 20, true);
    await job("passed", 5, 60 * 24 * 8, false); // 8 days ago: left out
    for (let i = 0; i < 12; i++) await job("passed", 1, 30 + i, true);

    const stats = await checkMachineStats(c.db, now);
    const runner = stats.find((s) => s.machine === "runner")!;
    expect(runner).toMatchObject({ total: 3, passed: 2, failed: 1, stuck: 0, medianSeconds: 1200, longestSeconds: 1800 });
    expect(runner.recent[0]!.ref).toMatch(/-\d+$/);
    const worker = stats.find((s) => s.machine === w!.id)!;
    expect(worker).toMatchObject({ total: 13, passed: 12, stuck: 1 });
    expect(worker.recent).toHaveLength(10);
    expect(worker.recent[0]!.result).toBe("stuck");
  });

  it("counts only the asked company's jobs when companyId is given", async () => {
    const c = (ctx = await setup());
    const other = (await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    const op = (await c.req("POST", `/api/companies/${other.company.id}/projects`, { name: "Other app" })).json() as { id: string };
    const ot = (await c.req("POST", `/api/projects/${op.id}/tickets`, { title: "Theirs" })).json() as { id: string };
    const now = new Date();
    const base = { kind: "pre_review", scope: "quick", state: "passed", runnerId: c.runnerId, startedAt: new Date(now.getTime() - 120_000), endedAt: new Date(now.getTime() - 60_000) };
    await c.db.insert(checkJobs).values({ ...base, companyId: c.company.id, projectId: c.project.id, ticketId: c.ticket.id, commit: "a".repeat(40), tree: "a".repeat(40) } as never);
    await c.db.insert(checkJobs).values({ ...base, companyId: other.company.id, projectId: op.id,ticketId: ot.id, commit: "b".repeat(40), tree: "b".repeat(40) } as never);
    const mine = await checkMachineStats(c.db, now, c.company.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.total).toBe(1);
    const res = await c.req("GET", `/api/settings/check-workers/stats?companyId=${other.company.id}`);
    expect((res.json() as { total: number }[])[0]!.total).toBe(1);
  });

  it("is served at the owner route and refused without a session", async () => {
    const c = (ctx = await setup());
    expect((await c.app.inject({ method: "GET", url: "/api/settings/check-workers/stats" })).statusCode).toBe(401);
    const res = await c.req("GET", "/api/settings/check-workers/stats");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
