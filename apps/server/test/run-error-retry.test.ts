// BOS-2357: a run that ends on a passing error is resumed by itself, twice an hour per ticket at most;
// any other error is a CEO card at once.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, runners, runs, tickets, wakes } from "../src/db/schema.js";
import { RUN_ERROR_RESUME_KIND, classifyRunError, runErrorRetry } from "../src/services/run-error-retry.js";

const MIN = 60_000;
let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
  const agent = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Basil" })).json() as { id: string };
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Work" })).json() as { id: string };
  await db.update(tickets).set({ assigneeAgentId: agent.id, systemState: "in_progress" }).where(eq(tickets.id, t.id));
  /** A run on the ticket that ends with `error`; waits until the end handling has settled. */
  const endWith = async (error: string) => {
    const [r] = await db.insert(runs).values({ companyId: company.id, agentId: agent.id, ticketId: t.id, startedAt: new Date(Date.now() - 5 * MIN), lastEventAt: new Date() }).returning();
    await emit({ type: "run.ended", runId: r!.id, stopReason: null, error });
    await new Promise((res) => setTimeout(res, 150)); // test-lines-ok: the run.ended chain runs unawaited in the server; no event says it finished
    return r!.id;
  };
  const cards = async () => (await db.select().from(decisions)).filter((d) => /passing error|does not know it/.test(d.question));
  return { ...built, db, close, endWith, cards, ticketId: t.id, companyId: company.id, agentId: agent.id, projectId: project.id };
}

describe("classifyRunError", () => {
  it.each([
    ["SSE read timed out", "transient"],
    ["Error: read ECONNRESET", "transient"],
    ["API Error: 529 Overloaded", "transient"],
    ["overloaded_error: Overloaded", "transient"],
    ["Request failed with status 503", "transient"],
    ["error: 502 Bad Gateway", "transient"],
    ["socket hang up", "transient"],
    ["Claude AI usage limit reached|1700000000", "account"],
    ["Invalid API key", "account"],
    ["The agent could not parse the tool answer", "other"],
  ])("%s is %s", (text, kind) => {
    expect(classifyRunError(text)).toBe(kind);
  });
});

describe("a run that ends on an error (BOS-2357)", () => {
  it("a passing error is resumed at once, twice an hour; the third raises one card naming the error", async () => {
    const c = (ctx = await setup());
    await c.endWith("SSE read timed out");
    await c.endWith("API Error: 529 Overloaded");
    const resumes = await c.db.select().from(wakes).where(eq(wakes.reason, "resume"));
    expect(resumes).toHaveLength(2);
    expect(resumes[0]!.note).toMatch(/ended on an error that usually passes by itself \(SSE read timed out\)/);
    expect(await c.cards()).toHaveLength(0);

    await c.endWith("SSE read timed out");
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "resume"))).toHaveLength(2);
    const cards = await c.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.question).toMatch(/SSE read timed out/);
  });

  it("any other error raises a CEO card at once and does not resume", async () => {
    const c = (ctx = await setup());
    await c.endWith("The agent could not parse the tool answer");
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "resume"))).toHaveLength(0);
    const cards = await c.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.question).toMatch(/could not parse the tool answer/);
  });

  // The BOS-2307 case: the old missed-work sweep skipped an agent with other wakes waiting, a ticket with a
  // booked check, or a wake within 4 h. The resume goes straight through onInterrupted and ignores all three.
  it("resumes although the agent has another wake queued and one deferred hours away", async () => {
    const c = (ctx = await setup());
    const [other] = await c.db.insert(tickets).values({ companyId: c.companyId, projectId: c.projectId, title: "Other", assigneeAgentId: c.agentId, systemState: "ready" }).returning();
    await c.db.insert(wakes).values({ companyId: c.companyId, agentId: c.agentId, ticketId: other!.id, reason: "nudge", status: "queued" });
    await c.db.insert(wakes).values({ companyId: c.companyId, agentId: c.agentId, reason: "refresh", status: "deferred", notBefore: new Date(Date.now() + 5 * 3_600_000) });
    await c.endWith("SSE read timed out");
    const resumes = await c.db.select().from(wakes).where(eq(wakes.reason, "resume"));
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.ticketId).toBe(c.ticketId);
  });

  it("resumes now when the ticket has a check booked an hour ahead, and leaves the booking alone", async () => {
    const c = (ctx = await setup());
    const monitorAt = new Date(Date.now() + 3_600_000);
    await c.db.update(tickets).set({ monitorAt }).where(eq(tickets.id, c.ticketId));
    await c.endWith("SSE read timed out");
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "resume"))).toHaveLength(1);
    const [t] = await c.db.select().from(tickets).where(eq(tickets.id, c.ticketId));
    expect(t!.monitorAt?.getTime()).toBe(monitorAt.getTime());
  });

  it("resumes although the agent was woken on this ticket an hour ago", async () => {
    const c = (ctx = await setup());
    await c.db.insert(wakes).values({ companyId: c.companyId, agentId: c.agentId, ticketId: c.ticketId, reason: "ceo", status: "launched", launchedAt: new Date(Date.now() - 3_600_000), createdAt: new Date(Date.now() - 3_600_000) });
    await c.endWith("API Error: 529 Overloaded");
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "resume"))).toHaveLength(1);
  });

  it("when nothing is queued (a deploy's run), it is not counted as a resume", async () => {
    const c = (ctx = await setup());
    const [run] = await c.db.insert(runs).values({ companyId: c.companyId, agentId: c.agentId, ticketId: c.ticketId, startedAt: new Date(Date.now() - 5 * MIN), lastEventAt: new Date(), outcome: "error: SSE read timed out" }).returning();
    const retry = runErrorRetry(c.db, { now: () => new Date(), resume: async () => null, alert: async () => null });
    expect(await retry.afterRun(run!.id)).toBe("skipped");
    expect(await retry.afterRun(run!.id)).toBe("skipped");
    expect(await c.db.select().from(activity).where(eq(activity.kind, RUN_ERROR_RESUME_KIND))).toHaveLength(0);
  });

  it("a run that ended cleanly is left alone", async () => {
    const c = (ctx = await setup());
    const [r] = await c.db.insert(runs).values({ companyId: (await c.db.select().from(tickets))[0]!.companyId, agentId: (await c.db.select().from(tickets))[0]!.assigneeAgentId!, ticketId: c.ticketId, startedAt: new Date() }).returning();
    await c.runners.ingest((await c.db.select().from(runners))[0]!, { seq: 1, at: new Date().toISOString(), event: { type: "run.ended", runId: r!.id, stopReason: "end_turn", error: null } as RunnerEvent });
    await new Promise((res) => setTimeout(res, 150)); // test-lines-ok: the run.ended chain runs unawaited in the server; no event says it finished
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "resume"))).toHaveLength(0);
    expect(await c.cards()).toHaveLength(0);
  });
});
