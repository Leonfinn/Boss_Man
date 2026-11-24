import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { costEvents, fundingSources, runs, ticketReviews, ticketTransitions, tickets } from "../src/db/schema.js";
import { AgentRecordError, agentRecordService } from "../src/services/agent-record.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

const HOUR = 3_600_000;

it("counts a finished ticket per agent over 30 days: first-time passes, send-backs, median time to merge", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const headers = { cookie: `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}` };
  const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers, payload: { name: "App Co" } })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await built.app.inject({ method: "POST", url: `/api/companies/${co.company.id}/agents`, headers, payload: { name: "Dev" } })).json() as { id: string };
  const project = (await built.app.inject({ method: "POST", url: `/api/companies/${co.company.id}/projects`, headers, payload: { name: "App" } })).json() as { id: string };

  const t0 = new Date("2026-11-20T12:00:00Z");
  const finish = async (title: string, ageHours: number, cycleHours: number, verdicts: string[]) => {
    const finished = new Date(t0.getTime() - ageHours * HOUR);
    const [t] = await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title, systemState: "done", assigneeAgentId: dev.id, stateChangedAt: finished }).returning();
    await db.insert(ticketTransitions).values({ companyId: co.company.id, ticketId: t!.id, fromState: "ready", toState: "in_progress", at: new Date(finished.getTime() - cycleHours * HOUR) });
    for (const verdict of verdicts) await db.insert(ticketReviews).values({ ticketId: t!.id, reviewer: "Rod", verdict });
    return t!;
  };
  await finish("Clean", 1, 2, ["approved"]);
  await finish("Sent back", 2, 6, ["changes_requested", "approved"]);
  await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Too old", systemState: "done", assigneeAgentId: dev.id, stateChangedAt: new Date(t0.getTime() - 40 * 24 * HOUR) });
  await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Still going", systemState: "in_progress", assigneeAgentId: dev.id });

  // Cost: runs of this agent on the two finished tickets, a run of another agent on the first one, and another agent's own finished ticket.
  const [src] = await db.insert(fundingSources).values({ name: "Key", kind: "api_payg", provider: "anthropic" }).returning();
  const cost = async (agentId: string, ticketId: string, micros: number) => {
    const [run] = await db.insert(runs).values({ companyId: co.company.id, agentId, ticketId, outcome: "end_turn", endedAt: new Date() }).returning();
    await db.insert(costEvents).values({ runId: run!.id, fundingSourceId: src!.id, companyId: co.company.id, costMicros: micros });
  };
  const [clean, sentBack] = await db.select().from(tickets).where(and(eq(tickets.assigneeAgentId, dev.id), inArray(tickets.title, ["Clean", "Sent back"]))).orderBy(desc(tickets.stateChangedAt));
  await cost(dev.id, clean!.id, 1_000_000);
  await cost(dev.id, clean!.id, 500_000);
  await cost(dev.id, sentBack!.id, 3_000_000);
  await cost(co.ceo.id, clean!.id, 9_000_000);
  const [other] = await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Theirs", systemState: "done", assigneeAgentId: co.ceo.id, stateChangedAt: new Date(t0.getTime() - HOUR) }).returning();
  await cost(co.ceo.id, other!.id, 7_000_000);
  // mergedAt wins over stateChangedAt as the finish time.
  const mergedAt = new Date(t0.getTime() - 30 * 60_000);
  await db.update(tickets).set({ mergedAt }).where(eq(tickets.id, clean!.id));

  // Runs: Dev has the 3 above; add two failed ones and an old failed one (outside the window).
  await db.insert(runs).values({ companyId: co.company.id, agentId: dev.id, outcome: "error: boom", endedAt: new Date() });
  await db.insert(runs).values({ companyId: co.company.id, agentId: dev.id, outcome: "error: again", endedAt: new Date() });
  await db.insert(runs).values({ companyId: co.company.id, agentId: dev.id, outcome: "error: old", startedAt: new Date(t0.getTime() - 40 * 24 * HOUR), endedAt: new Date(t0.getTime() - 40 * 24 * HOUR) });

  const rec = await agentRecordService(db, { now: () => t0 }).record(dev.id);
  expect(rec.runs).toBe(5);
  expect(rec.failedRuns).toBe(2);
  expect(rec.finished).toBe(2);
  expect(rec.passedFirstTime).toBe(1);
  expect(rec.sendBacks).toBe(1);
  expect(rec.medianMergeMs).toBe((2.5 * HOUR + 6 * HOUR) / 2);
  expect(rec.costPerFinishedMicros).toBe(2_250_000);
  expect(rec.recent.map((r) => r.title)).toEqual(["Clean", "Sent back"]);
  expect(rec.recent.map((r) => r.costMicros)).toEqual([1_500_000, 3_000_000]);
  expect(rec.recent[0]!.finishedAt).toBe(mergedAt.toISOString());
  expect(rec.recent[1]!.sendBacks).toBe(1);

  // The other agent sees only its own ticket and its own cost: not the Dev's tickets, nor its 9M run on Dev's ticket.
  const theirs = await agentRecordService(db, { now: () => t0 }).record(co.ceo.id);
  expect(theirs.finished).toBe(1);
  expect(theirs.recent.map((r) => r.title)).toEqual(["Theirs"]);
  expect(theirs.costPerFinishedMicros).toBe(7_000_000);

  const idle = (await built.app.inject({ method: "POST", url: `/api/companies/${co.company.id}/agents`, headers, payload: { name: "Idle" } })).json() as { id: string };
  const none = await agentRecordService(db, { now: () => t0 }).record(idle.id);
  expect(none.finished).toBe(0);
  expect(none).toMatchObject({ runs: 0, failedRuns: 0 });
  expect(none.recent).toEqual([]);
  await expect(agentRecordService(db).record(randomUUID())).rejects.toBeInstanceOf(AgentRecordError);
});

it("GET /api/agents/:id/record returns the last 10 finished tickets newest first, and 404 for an unknown agent", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const headers = { cookie: `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}` };
  const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers, payload: { name: "App Co" } })).json() as { company: { id: string } };
  const dev = (await built.app.inject({ method: "POST", url: `/api/companies/${co.company.id}/agents`, headers, payload: { name: "Dev" } })).json() as { id: string };
  const project = (await built.app.inject({ method: "POST", url: `/api/companies/${co.company.id}/projects`, headers, payload: { name: "App" } })).json() as { id: string };
  const [src] = await db.insert(fundingSources).values({ name: "Key", kind: "api_payg", provider: "anthropic" }).returning();
  for (let i = 1; i <= 11; i++) {
    const [t] = await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: `T${i}`, size: 3, systemState: "done", assigneeAgentId: dev.id, stateChangedAt: new Date(Date.now() - i * HOUR) }).returning();
    if (i === 2) await db.insert(ticketReviews).values({ ticketId: t!.id, reviewer: "Rod", verdict: "changes_requested" });
    const [run] = await db.insert(runs).values({ companyId: co.company.id, agentId: dev.id, ticketId: t!.id, outcome: "end_turn", endedAt: new Date() }).returning();
    await db.insert(costEvents).values({ runId: run!.id, fundingSourceId: src!.id, companyId: co.company.id, costMicros: i * 1000 });
  }
  const res = await built.app.inject({ method: "GET", url: `/api/agents/${dev.id}/record`, headers });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { finished: number; recent: Array<{ ref: string | null; title: string; size: number | null; finishedAt: string; sendBacks: number; costMicros: number }> };
  expect(body.finished).toBe(11);
  expect(body.recent).toHaveLength(10);
  expect(body.recent.map((r) => r.title)).toEqual(Array.from({ length: 10 }, (_, i) => `T${i + 1}`));
  expect(body.recent[0]).toMatchObject({ title: "T1", size: 3, sendBacks: 0, costMicros: 1000 });
  expect(body.recent[0]!.ref).toEqual(expect.any(String));
  expect(Date.parse(body.recent[0]!.finishedAt)).not.toBeNaN();
  expect(body.recent[1]!.sendBacks).toBe(1);
  // The owner is global (as for /history): there is no per-company scoping, so an unknown id is the only 404.
  expect((await built.app.inject({ method: "GET", url: `/api/agents/${randomUUID()}/record`, headers })).statusCode).toBe(404);
});
