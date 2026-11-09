// The CEO's reply lane (BOS-434, fix A of BOS-428): an owner message or a card for the CEO starts a
// short parallel run while a long CEO run is open, outside the work limits.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runs, tickets, wakes } from "../src/db/schema.js";

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
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "run.start") commands.push(c);
    return true;
  });
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const [ticket] = await db.insert(tickets).values({ companyId: company.id, projectId: project.id, title: "Something", assigneeAgentId: ceo.id }).returning();
  /** The CEO is in the middle of a long run. */
  const busy = async () => {
    const id = randomUUID();
    await db.insert(runs).values({ id, companyId: company.id, agentId: ceo.id, ticketId: null, origin: "decision", startedAt: new Date() });
    return id;
  };
  return { ...built, db, close, req, company, ceo, worker, ticket: ticket!, commands, busy };
}

describe("CEO reply lane", () => {
  it("starts a short parallel run for an owner message while a long CEO run is open", async () => {
    const c = (ctx = await setup());
    const long = await c.busy();
    await c.scheduler.wake({ agentId: c.ceo.id, ticketId: c.ticket.id, reason: "message", priority: 3, note: "The owner has written to you on this ticket." });
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(1);
    const start = c.commands[0]!;
    // The CEO's run tools (not the chat's board-only set), no worktree, no chapter.
    expect(start.boardToolsOnly).toBeUndefined();
    expect(start.workspace).toBeUndefined();
    expect(start.cwd).toBe(`/ws/reply/${c.ceo.id}`);
    expect(start.prompt).toContain("short reply run");
    const [run] = await c.db.select().from(runs).where(eq(runs.id, start.runId));
    expect(run).toMatchObject({ purpose: "reply", origin: "ceo reply", ticketId: c.ticket.id, chapterId: null });
    expect(run!.id).not.toBe(long);
    // The ticket was not started by it.
    expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).not.toBe("in_progress");
  });

  it("takes no work slot, and a second reply waits for the first to end", async () => {
    const c = (ctx = await setup());
    await c.busy();
    await c.scheduler.wake({ agentId: c.ceo.id, ticketId: c.ticket.id, reason: "message", priority: 3, note: "one" });
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(1);
    // The reply run is not counted against the CEO's work: other agents' work still starts at once.
    await c.scheduler.wake({ agentId: c.worker.id, reason: "decision", note: "work" });
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(2);
    // A second reply while the first is open waits for the agent's one reply slot.
    await c.scheduler.wake({ agentId: c.ceo.id, ticketId: c.ticket.id, reason: "message", priority: 3, note: "two" });
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(2);
    const waiting = await c.db.select().from(wakes).where(eq(wakes.reason, "ceo reply"));
    expect(waiting.map((w) => w.statusReason)).toContain("at a concurrency limit: this agent is already answering");
  });

  it("starts nothing extra when the CEO has no run open", async () => {
    const c = (ctx = await setup());
    await c.scheduler.wake({ agentId: c.ceo.id, ticketId: c.ticket.id, reason: "message", priority: 3, note: "hello" });
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "ceo reply"))).toHaveLength(0);
  });

  it("ignores a message an agent sent, and a worker's messages", async () => {
    const c = (ctx = await setup());
    const long = await c.busy();
    await c.scheduler.wake({ agentId: c.ceo.id, ticketId: c.ticket.id, reason: "message", causedByRunId: long, note: "from a run" });
    await c.scheduler.wake({ agentId: c.worker.id, reason: "message", note: "hi" });
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "ceo reply"))).toHaveLength(0);
  });

  it("gives a card for the CEO a reply run too, only when the wake asks for it", async () => {
    const c = (ctx = await setup());
    await c.busy();
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "decision", note: "plain card" });
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "ceo reply"))).toHaveLength(0);
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "decision", replyLane: true, note: "A permission card is waiting." });
    const [w] = await c.db.select().from(wakes).where(eq(wakes.reason, "ceo reply"));
    expect(w).toMatchObject({ priority: 4, note: "A permission card is waiting." });
  });

  it("DR-048 A: an idle CEO's card wake asking for the lane is queued as the reply wake, not the plain one", async () => {
    const c = (ctx = await setup());
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "decision", replyLane: true, note: "A permission card is waiting." });
    const rows = await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id));
    expect(rows.map((w) => w.reason)).toEqual(["ceo reply"]);
    // Without the lane the plain wake is queued as before.
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "decision", note: "plain" });
    expect((await c.db.select().from(wakes).where(eq(wakes.reason, "decision"))).length).toBe(1);
  });
});
