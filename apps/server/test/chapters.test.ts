import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ceoChapters, runners, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

type Start = Extract<RunnerCommand, { type: "run.start" }>;

async function setup() {
  const { db, close } = await openPglite();
  let clock = new Date("2026-10-16T09:00:00Z");
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co", mission: "Ship a calm budgeting app." })).json();
  await req("POST", `/api/companies/${company.id}/objectives`, { title: "Launch the beta", priority: 1 });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  /** Wakes the CEO, returns the run.start it got, and optionally starts and ends it. */
  const run = async (opts: { session?: string; context?: [number, number]; end?: boolean } = {}) => {
    await db.delete(wakes);
    sent.length = 0;
    await built.scheduler.wake({ agentId: ceo.id, reason: "decision", note: "A decision is waiting for you." });
    await built.scheduler.tick();
    const start = sent.find((x): x is Start => x.type === "run.start")!;
    await emit({ type: "run.started", runId: start.runId, agentId: ceo.id, acpSessionId: opts.session ?? start.resumeSessionId ?? `s-${start.runId.slice(0, 4)}`, model: null, resumed: !!start.resumeSessionId });
    if (opts.context) await emit({ type: "run.context", runId: start.runId, used: opts.context[0], size: opts.context[1] });
    await settle();
    const end = async () => (await emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null }), await settle());
    if (opts.end !== false) await end();
    return { start, end };
  };
  const chapters = () => db.select().from(ceoChapters).orderBy(ceoChapters.number);
  const handoff = async (runId: string, summary: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId: ceo.id, runId });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const r = await c.callTool({ name: "handoff", arguments: { summary } });
    await c.close();
    return (r as { content: Array<{ text: string }> }).content[0]!.text;
  };
  return { ...built, db, req, company, ceo, run, chapters, handoff, setClock: (d: Date) => (clock = d), emit, settle };
}

describe("CEO chapters", () => {
  it("continue one session, close at 70% context with the CEO's handoff, and open the next chapter with it", async () => {
    const c = await setup();
    const first = await c.run({ session: "s1" });
    expect(first.start.resumeSessionId).toBeUndefined();
    expect(first.start.prompt).toContain("This is chapter 1 of your work.");
    expect(first.start.prompt).toContain("Mission: Ship a calm budgeting app.");
    expect(first.start.prompt).toContain("P1 Launch the beta");
    expect(first.start.prompt).toContain("A decision is waiting for you.");
    expect((await c.chapters())[0]).toMatchObject({ number: 1, acpSessionId: "s1", endedAt: null });

    // The next wake resumes the session with only what's new; the directive stays as it was.
    await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Cut churn", priority: 2 });
    const second = await c.run({ context: [150_000, 200_000] });
    expect(second.start.resumeSessionId).toBe("s1");
    expect(second.start.prompt).not.toContain("This is chapter");
    expect(second.start.prompt).toContain("A decision is waiting for you.");
    // If the session can't be reopened, the fresh one gets the frozen opening.
    expect(second.start.freshPrompt).toContain("This is chapter 1 of your work.");
    expect(second.start.freshPrompt).not.toContain("Cut churn");
    expect((await c.chapters())[0]).toMatchObject({ contextUsed: 150_000, contextSize: 200_000 });

    // 75% full: the next run closes the chapter, in the same session.
    const third = await c.run({ end: false });
    expect(third.start.resumeSessionId).toBe("s1");
    expect(third.start.prompt).toContain("This chapter is closing because your context is over 70% full");
    expect(await c.handoff(third.start.runId, "Beta is two tickets from done. The owner wants weekly updates.")).toBe("Handoff saved for chapter 2.");
    await third.end();
    expect((await c.chapters())[0]).toMatchObject({ endReason: "context", handoffBy: "ceo", endedAt: expect.any(Date) });

    const fourth = await c.run({ session: "s2" });
    expect(fourth.start.resumeSessionId).toBeUndefined();
    expect(fourth.start.prompt).toContain("This is chapter 2 of your work.");
    expect(fourth.start.prompt).toContain("Cut churn");
    expect(fourth.start.prompt).toContain("Handoff from your previous chapter:\nBeta is two tickets from done.");
    expect((await c.chapters()).map((x) => [x.number, x.acpSessionId, x.endedAt === null])).toEqual([
      [1, "s1", false],
      [2, "s2", true],
    ]);
  });

  it("close when the owner asks or after 7 days, with Boss Man's handoff if the CEO wrote none", async () => {
    const c = await setup();
    await c.run({ session: "s1" });
    expect((await c.req("POST", `/api/companies/${c.company.id}/chapters/roll`)).statusCode).toBe(200);
    const closing = await c.run();
    expect(closing.start.prompt).toContain("because the owner asked for a new chapter");
    const [one] = await c.chapters();
    expect(one).toMatchObject({ endReason: "owner", handoffBy: "boss_man" });
    expect(one!.handoff).toContain("The previous chapter ended (the owner asked for a new chapter) without a handoff");

    await c.run({ session: "s2" });
    c.setClock(new Date("2026-10-24T09:00:00Z"));
    const aged = await c.run();
    expect(aged.start.prompt).toContain("because it's 7 days old");

    const list = (await c.req("GET", `/api/companies/${c.company.id}/chapters`)).json();
    expect(list.map((x: { number: number; runs: number }) => [x.number, x.runs])).toEqual([
      [2, 2],
      [1, 2],
    ]);
  });

  it("are only for the CEO; handoff is refused to other agents", async () => {
    const c = await setup();
    const worker = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer" })).json();
    const project = (await c.req("POST", `/api/companies/${c.company.id}/projects`, { name: "App" })).json();
    const t = (await c.req("POST", `/api/projects/${project.id}/tickets`, { title: "Fix login", risk: "trivial", state: "ready", assigneeAgentId: worker.id })).json();
    await c.db.delete(wakes);
    await c.scheduler.wake({ agentId: worker.id, ticketId: t.id, reason: "assigned" });
    await c.scheduler.tick();
    expect(await c.chapters()).toEqual([]);
  });
});

describe("graded planning", () => {
  it("asks for planning in proportion to risk, and plans high-risk work first", async () => {
    const c = await setup();
    const worker = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer" })).json();
    const project = (await c.req("POST", `/api/companies/${c.company.id}/projects`, { name: "App" })).json();
    const make = async (fields: Record<string, unknown>) => (await c.req("POST", `/api/projects/${project.id}/tickets`, { title: "Work", ...fields })).json() as { id: string; planFirst: boolean };
    expect((await make({ risk: "high" })).planFirst).toBe(true);
    expect((await make({ risk: "critical", planFirst: false })).planFirst).toBe(false);
    expect((await make({ risk: "medium" })).planFirst).toBe(false);

    const trivial = await make({ risk: "trivial", state: "ready", assigneeAgentId: worker.id });
    await c.db.delete(wakes);
    await c.scheduler.wake({ agentId: worker.id, ticketId: trivial.id, reason: "assigned" });
    const sent: RunnerCommand[] = [];
    c.runners.connect((await c.db.select().from(runners))[0]!.id, (x) => (sent.push(x), true));
    await c.scheduler.tick();
    const start = sent.find((x): x is Start => x.type === "run.start")!;
    expect(start.prompt).toContain("Planning: this is trivial. Make the change directly; no plan needed.");
    expect((await c.db.select().from(tickets).where(eq(tickets.id, trivial.id)))[0]!.planFirst).toBe(false);
  });
});
