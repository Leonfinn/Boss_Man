import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { notifications, runners, runs, tickets, wakes } from "../src/db/schema.js";
import { TREE_REASON, WATCH_REASON } from "../src/services/scheduler.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  let clock = new Date("2026-10-18T09:00:00Z");
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const scrum = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Scrum Master" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: clock.toISOString(), event });
  const starts = () => sent.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  const advance = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));
  const watchWakes = () => db.select().from(wakes).where(eq(wakes.reason, WATCH_REASON));
  return { ...built, db, close, req, base, company, scrum, project, emit, starts, advance, watchWakes, now: () => clock };
}

describe("ticket watchers (R80)", () => {
  it("is off by default, and reports on a schedule once turned on, with what the ticket depends on", async () => {
    const c = (ctx = await setup());
    const blocker = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Pick a payments provider" })).json() as { id: string };
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Add checkout" })).json() as { id: string };
    await c.req("POST", `/api/tickets/${t.id}/dependencies`, { ticketId: blocker.id });
    await c.scheduler.tick();
    expect(await c.watchWakes()).toEqual([]);

    const on = await c.req("PUT", `/api/tickets/${t.id}/watcher`, { agentId: c.scrum.id, everyMinutes: 30 });
    expect(on.json()).toMatchObject({ watcherAgentId: c.scrum.id, watchEveryMinutes: 30, watchedAt: null });
    await c.scheduler.tick();
    const [first] = c.starts().filter((s) => s.agentId === c.scrum.id);
    expect(first).toBeDefined();
    // A watch run has no ticket, so it never touches the ticket's branch or moves it.
    expect(first!.workspace).toBeUndefined();
    expect(first!.prompt).toContain(`Ticket ${t.id} "Add checkout"`);
    expect(first!.prompt).toContain(`Depends on ticket ${blocker.id} "Pick a payments provider"`);
    expect(first!.prompt).toContain("post ONE short status update on that ticket with ticket_reply");
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).not.toBe("in_progress");

    // The watcher's reply is the owner's status update.
    const token = await issueRunToken(c.db, { companyId: c.company.id, agentId: c.scrum.id, runId: first!.runId });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://${c.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    await client.callTool({ name: "ticket_reply", arguments: { ticketId: t.id, text: "Waiting on the payments provider ticket, which hasn't started." } });
    await client.close();
    expect((await c.db.select().from(notifications)).map((n) => n.title)).toContain('Status: "Add checkout"');
    await c.emit({ type: "run.ended", runId: first!.runId, stopReason: "end_turn", error: null });

    // Not again until 30 minutes have passed.
    c.advance(20);
    await c.scheduler.tick();
    expect(await c.watchWakes()).toHaveLength(1);
    // Due, and something changed, so it reports again.
    await c.db.update(tickets).set({ title: "Add checkout flow" }).where(eq(tickets.id, t.id));
    c.advance(11);
    await c.scheduler.tick();
    expect(await c.watchWakes()).toHaveLength(2);
  });

  it("runs only when the ticket's facts changed, and reports anyway after four intervals (R85)", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Add checkout" })).json() as { id: string };
    await c.req("PUT", `/api/tickets/${t.id}/watcher`, { agentId: c.scrum.id, everyMinutes: 10 });
    const round = async (change?: () => Promise<unknown>) => {
      await change?.();
      c.advance(11);
      await c.scheduler.tick();
      const run = c.starts().filter((s) => s.agentId === c.scrum.id).at(-1);
      if (run) await c.emit({ type: "run.ended", runId: run.runId, stopReason: "end_turn", error: null });
      return (await c.watchWakes()).length;
    };
    await c.scheduler.tick();
    expect(await c.watchWakes()).toHaveLength(1);
    // Nothing changed: no run, but it's still checked on schedule.
    expect(await round()).toBe(1);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.watchedAt).toEqual(c.now());
    // A new message from the owner is a change.
    expect(await round(() => c.req("POST", `/api/tickets/${t.id}/messages`, { text: "Any news?" }))).toBe(2);
    expect(await round()).toBe(2);
    expect(await round()).toBe(2);
    expect(await round()).toBe(2);
    // The fourth quiet interval since the last report forces one.
    expect(await round()).toBe(3);
  });

  it("covers every due ticket in one run, gives a final report when done, and can be turned off", async () => {
    const c = (ctx = await setup());
    const a = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Ticket A" })).json() as { id: string };
    const b = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Ticket B" })).json() as { id: string };
    await c.db.update(tickets).set({ watcherAgentId: c.scrum.id, watchEveryMinutes: 15, monitorAt: new Date("2030-01-01") }); // a scheduled check keeps the tree from counting as stopped
    // The watcher is busy elsewhere: its waiting run gathers every ticket that falls due.
    await c.req("PATCH", `/api/agents/${c.scrum.id}`, { paused: true });
    await c.scheduler.tick();
    let [w] = await c.watchWakes();
    expect(w!.note).toContain(`Watch ticket ${a.id}`);
    expect(w!.note).toContain(`Watch ticket ${b.id}`);
    c.advance(16);
    await c.scheduler.tick();
    expect(await c.watchWakes()).toHaveLength(1);
    await c.req("PATCH", `/api/agents/${c.scrum.id}`, { paused: false });
    await c.scheduler.tick();
    const run = c.starts().find((s) => s.agentId === c.scrum.id)!;
    expect(run.prompt).toContain('"Ticket A"');
    expect(run.prompt).toContain('"Ticket B"');
    await c.emit({ type: "run.ended", runId: run.runId, stopReason: "end_turn", error: null });

    // A finishes: one final report, then no more.
    c.advance(1);
    await c.req("PATCH", `/api/tickets/${a.id}`, { state: "done" });
    await c.req("PUT", `/api/tickets/${b.id}/watcher`, { agentId: null });
    await c.scheduler.tick();
    [, w] = await c.watchWakes();
    expect(w!.note).toBe(`Watch ticket ${a.id}`);
    const last = c.starts().filter((s) => s.agentId === c.scrum.id).at(-1)!;
    expect(last.prompt).toContain("(now done: give a final update)");
    await c.emit({ type: "run.ended", runId: last.runId, stopReason: "end_turn", error: null });
    c.advance(120);
    await c.scheduler.tick();
    expect(await c.watchWakes()).toHaveLength(2);
  });

  it("only takes an agent from the ticket's company, and isn't held back by the no-ticket limit", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Add checkout" })).json() as { id: string };
    const other = (await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { ceo: { id: string } };
    expect((await c.req("PUT", `/api/tickets/${t.id}/watcher`, { agentId: other.ceo.id })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await c.req("PUT", `/api/tickets/${t.id}/watcher`, { agentId: c.scrum.id, everyMinutes: 5 })).statusCode).toBe(400);

    await c.req("PUT", `/api/tickets/${t.id}/watcher`, { agentId: c.scrum.id, everyMinutes: 10 });
    await c.db.update(tickets).set({ monitorAt: new Date("2030-01-01") }).where(eq(tickets.id, t.id));
    for (let i = 0; i < 8; i++) {
      await c.scheduler.tick();
      const run = c.starts().filter((s) => s.agentId === c.scrum.id).at(-1);
      if (run) await c.emit({ type: "run.ended", runId: run.runId, stopReason: "end_turn", error: null });
      await c.db.update(tickets).set({ title: `Add checkout ${i}` }).where(eq(tickets.id, t.id));
      c.advance(10);
    }
    expect((await c.watchWakes()).filter((w) => w.status === "dropped")).toEqual([]);
    expect((await c.watchWakes()).length).toBeGreaterThanOrEqual(7);
  });

  describe("watchdog: the watcher steps in when its whole tree has stopped", () => {
    const farFuture = new Date("2030-01-01");
    async function tree(c: Awaited<ReturnType<typeof setup>>) {
      const root = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Ship checkout" })).json() as { id: string };
      const kid = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Write payment form" })).json() as { id: string };
      const other = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Unrelated chore" })).json() as { id: string };
      await c.db.update(tickets).set({ parentTicketId: root.id }).where(eq(tickets.id, kid.id));
      await c.req("PUT", `/api/tickets/${root.id}/watcher`, { agentId: c.scrum.id, everyMinutes: 30 });
      return { root, kid, other };
    }
    const treeWakes = (c: Awaited<ReturnType<typeof setup>>) => c.db.select().from(wakes).where(eq(wakes.reason, TREE_REASON));
    const endRuns = async (c: Awaited<ReturnType<typeof setup>>) => {
      for (const s of c.starts()) await c.emit({ type: "run.ended", runId: s.runId, stopReason: "end_turn", error: null });
    };

    // The first report is due too and goes first; the tree wake runs once that run has ended.
    async function treeRun(c: Awaited<ReturnType<typeof setup>>) {
      const find = () => c.starts().find((x) => x.agentId === c.scrum.id && x.prompt.includes("has stopped"));
      await c.scheduler.tick();
      if (!find()) {
        await endRuns(c);
        await c.scheduler.tick();
      }
      return find();
    }

    it("wakes once per stopped state, listing what is stopped, and again when the state changes", async () => {
      const c = (ctx = await setup());
      const { root, kid } = await tree(c);
      const run = await treeRun(c);
      const [w] = await treeWakes(c);
      expect(w!.note).toContain(`Tree of ticket ${root.id}`);
      expect(w!.note).toContain('- "Ship checkout" (backlog), assigned to nobody; waits on nothing');
      expect(w!.note).toContain('- "Write payment form" (backlog)');
      expect(w!.note).toContain("only a CEO or manager may");
      expect(run).toBeDefined();
      await endRuns(c);

      c.advance(5);
      await c.scheduler.tick();
      expect(await treeWakes(c)).toHaveLength(1);
      // The sweep leaves a stopped watched tree to its watcher.
      expect((await c.db.select().from(tickets).where(eq(tickets.id, root.id)))[0]!.watchStoppedFp).not.toBeNull();

      await c.req("PATCH", `/api/tickets/${kid.id}`, { state: "ready" });
      c.advance(5);
      await c.scheduler.tick();
      expect(await treeWakes(c)).toHaveLength(2);
    });

    it("is not stopped while anything in the tree runs, is waiting to wake or has a scheduled check, and a done tree is left alone", async () => {
      const c = (ctx = await setup());
      const { root, kid } = await tree(c);
      const [live] = await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.scrum.id, ticketId: kid.id }).returning();
      await c.scheduler.tick();
      expect(await treeWakes(c)).toEqual([]);
      await c.db.update(runs).set({ endedAt: c.now() }).where(eq(runs.id, live!.id));

      await c.db.update(tickets).set({ monitorAt: farFuture }).where(eq(tickets.id, kid.id));
      await c.scheduler.tick();
      expect(await treeWakes(c)).toEqual([]);
      await c.db.update(tickets).set({ monitorAt: null }).where(eq(tickets.id, kid.id));

      await c.db.insert(wakes).values({ companyId: c.company.id, agentId: c.scrum.id, ticketId: root.id, reason: "message", status: "deferred", notBefore: farFuture });
      await c.scheduler.tick();
      expect(await treeWakes(c)).toEqual([]);
      await c.db.delete(wakes);

      await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.watcherAgentId, c.scrum.id));
      await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, kid.id));
      await c.scheduler.tick();
      expect(await treeWakes(c)).toEqual([]);
    });

    it("refuses a tree-stopped run's changes outside its tree", async () => {
      const c = (ctx = await setup());
      const { root, kid, other } = await tree(c);
      const run = (await treeRun(c))!;
      const token = await issueRunToken(c.db, { companyId: c.company.id, agentId: c.scrum.id, runId: run.runId });
      const client = new Client({ name: "t", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://${c.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text;
      const outside = /outside the tree/;
      expect(await call("assign_ticket", { ticketId: other.id, agent: "Scrum Master", note: "yours" })).toMatch(outside);
      expect(await call("nudge", { agent: "Scrum Master", ticketId: other.id, why: "look" })).toMatch(outside);
      expect(await call("create_ticket", { title: "Loose end" })).toMatch(outside);
      expect(await call("create_ticket", { title: "Sub of other", parent: other.id })).toMatch(outside);
      // Inside the tree the guard steps aside (the role check or the tool itself answers).
      expect(await call("assign_ticket", { ticketId: kid.id, agent: "Scrum Master", note: "yours" })).not.toMatch(outside);
      expect(await call("create_ticket", { title: "Sub of root", parent: root.id })).not.toMatch(outside);
      await client.close();
    });
  });
});
