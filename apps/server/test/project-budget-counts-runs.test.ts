// BOS-1564: a project spending limit must count the cost of real runs on that project's tickets.
// The create route exists and the scheduler honours project limits, but run.cost rows used to carry
// no project, so a project limit counted nothing from real work.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { costEvents, runners } from "../src/db/schema.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
});

describe("project spending limit counts the project's runs (BOS-1564)", () => {
  it("a run on a project ticket adds its cost to that project's limit, not to another project's", async () => {
    const { db, close: closeDb } = await openPglite();
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
    close = async () => (await built.app.close(), await closeDb());
    const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
    const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
    const other = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Other" })).json() as { id: string };
    const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
    const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
    const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
    built.runners.connect(reg.runnerId, (c) => {
      if (c.type === "run.start") commands.push(c);
      return true;
    });
    let seq = 0;
    const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
    const fs = (await req("POST", "/api/funding-sources", { name: "API", kind: "api_payg", provider: "anthropic" })).json() as { id: string };

    await req("POST", `/api/projects/${project.id}/tickets`, { title: "One", assigneeAgentId: ceo.id });
    await req("POST", "/api/scheduler/tick");
    const run = commands.find((c) => c.agentId === ceo.id)!;
    expect(run).toBeTruthy();
    await emit({ type: "run.cost", runId: run.runId, fundingSourceId: fs.id, costMicrosDelta: 2_000_000, model: "claude-sonnet-4-5" });

    for (const p of [project, other]) await req("POST", "/api/budget-policies", { scopeKind: "project", scopeId: p.id, windowKind: "lifetime", limitUsd: 1, onLimit: "ask" });
    const rows = await db.select().from(costEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projectId).toBe(project.id);

    const statuses = (await req("GET", "/api/budgets")).json() as Array<{ policy: { scopeId: string }; status: { spentMicros?: number; action: string } }>;
    const mine = statuses.find((b) => b.policy.scopeId === project.id)!;
    const theirs = statuses.find((b) => b.policy.scopeId === other.id)!;
    expect(mine.status.action).toBe("ask");
    expect(theirs.status.action).not.toBe("ask");
  });
});
