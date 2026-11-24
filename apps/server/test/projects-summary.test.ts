// BOS-2421: one read of every project's figures for Settings → Projects.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { costEvents, fundingSources, runs, tickets } from "../src/db/schema.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

describe("GET /api/companies/:id/projects-summary", () => {
  it("counts open, review, points, finished in 30 days, this month's spend and the last merge per project", async () => {
    const { db, close: closeDb } = await openPglite();
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
    close = async () => (await built.app.close(), await closeDb());
    const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    const busy = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Busy" })).json() as { id: string };
    const idle = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Idle" })).json() as { id: string };
    await req("PATCH", `/api/projects/${busy.id}`, { monthlyCapUsd: 100 });

    const { company: rival } = (await req("POST", "/api/companies", { name: "Rival Co" })).json() as { company: { id: string } };
    const foreign = (await req("POST", `/api/companies/${rival.id}/projects`, { name: "Foreign" })).json() as { id: string };
    const now = new Date();
    const mergedAt = new Date(now.getTime() - 86_400_000);
    const base = { companyId: company.id, projectId: busy.id };
    await db.insert(tickets).values([
      { ...base, title: "Backlog sized", systemState: "backlog", size: 3 },
      { ...base, title: "Review sized", systemState: "review", size: 5 },
      { ...base, title: "Review unsized", systemState: "review" },
      { ...base, title: "Done lately", systemState: "done", size: 8, mergedAt, stateChangedAt: mergedAt },
      { ...base, title: "Done long ago", systemState: "done", size: 2, stateChangedAt: new Date(now.getTime() - 60 * 86_400_000) },
      { ...base, title: "Cancelled", systemState: "done", outcome: "cancelled", stateChangedAt: mergedAt },
    ]);
    const [src] = await db.insert(fundingSources).values({ name: "API", kind: "api_credit", provider: "anthropic" }).returning();
    const [t] = await db.select().from(tickets).limit(1);
    const [run] = await db.insert(runs).values({ companyId: company.id, ticketId: t!.id }).returning();
    await db.insert(costEvents).values({ runId: run!.id, fundingSourceId: src!.id, companyId: company.id, costMicros: 42_000_000 });

    const res = await req("GET", `/api/companies/${company.id}/projects-summary`);
    expect(res.statusCode).toBe(200);
    const list = (res.json() as { projects: Record<string, unknown>[] }).projects;
    expect(list.map((p) => p.projectId).sort()).toEqual([busy.id, idle.id].sort());
    expect(list.some((p) => p.projectId === foreign.id)).toBe(false);
    const b = list.find((p) => p.projectId === busy.id)!;
    expect(b).toMatchObject({ open: 3, inReview: 2, pointsLeft: 8, unsized: 1, finishedLast30Days: 1, monthMicros: 42_000_000, monthlyCapMicros: 100_000_000, lastMergeAt: mergedAt.toISOString() });
    const i = list.find((p) => p.projectId === idle.id)!;
    expect(i).toMatchObject({ open: 0, inReview: 0, pointsLeft: 0, unsized: 0, finishedLast30Days: 0, monthMicros: 0, monthlyCapMicros: null, lastMergeAt: null });
  });
});
