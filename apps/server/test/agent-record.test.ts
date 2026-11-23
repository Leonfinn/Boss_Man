import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ticketReviews, ticketTransitions, tickets } from "../src/db/schema.js";
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

  const rec = await agentRecordService(db, { now: () => t0 }).record(dev.id);
  expect(rec.finished).toBe(2);
  expect(rec.passedFirstTime).toBe(1);
  expect(rec.sendBacks).toBe(1);
  expect(rec.medianMergeMs).toBe(4 * HOUR);
  expect(rec.costPerFinishedMicros).toBe(0);
  expect(rec.recent.map((r) => r.title)).toEqual(["Clean", "Sent back"]);
  expect(rec.recent[1]!.sendBacks).toBe(1);

  const none = await agentRecordService(db, { now: () => t0 }).record(co.ceo.id);
  expect(none.finished).toBe(0);
  expect(none.recent).toEqual([]);
  await expect(agentRecordService(db).record(randomUUID())).rejects.toBeInstanceOf(AgentRecordError);
});
