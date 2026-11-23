import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, runners, runs, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

type Start = Extract<RunnerCommand, { type: "run.start" }>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
  const starts = () => sent.filter((c): c is Start => c.type === "run.start");
  const mcp = async (agentId: string, runId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, req, company, ceo, project, emit, starts, mcp };
}

const flush = () => new Promise((r) => setTimeout(r, 100));
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("recovery after a runner restart (R42)", () => {
  it("picks an interrupted run up on the same ticket, reopening its session with what it had done", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Checkout error states", assigneeAgentId: c.ceo.id })).json();
    await c.scheduler.tick();
    const first = c.starts()[0]!;
    await c.emit({ type: "run.started", runId: first.runId, agentId: c.ceo.id, acpSessionId: "sess-abc", model: "opus" });
    for (const title of ["Read src/checkout.ts", "Read src/checkout.ts", "npm test"]) {
      await c.emit({ type: "run.update", runId: first.runId, update: { kind: "tool_call_update", title, toolKind: "read", status: "completed" } });
    }
    await c.emit({ type: "run.update", runId: first.runId, update: { kind: "tool_call_update", title: "git commit", toolKind: "execute", status: "in_progress" } });

    await c.emit({ type: "run.ended", runId: first.runId, stopReason: null, error: "The runner restarted while this run was going.", interrupted: true });
    await flush();

    expect((await c.db.select().from(runs).where(eq(runs.id, first.runId)))[0]!.outcome).toBe("interrupted");
    const [w] = await c.db.select().from(wakes).where(eq(wakes.reason, "resume"));
    expect(w).toMatchObject({ agentId: c.ceo.id, ticketId: t.id, resumeRunId: first.runId, causedByRunId: null, causationDepth: 0 });
    expect(w!.note).toContain("1. Read src/checkout.ts\n2. npm test");
    expect(w!.note).not.toContain("git commit");
    expect(w!.note).toMatch(/check whether it already happened/);

    const second = c.starts()[1]!;
    expect(second).toMatchObject({ resumeSessionId: "sess-abc", cwd: `/ws/${t.id}` });
    expect(second.prompt).toContain("Checkout error states");
  });

  it("starts non-Claude agents fresh, with the same summary", async () => {
    const c = (ctx = await setup());
    await c.db.update(agents).set({ agentKind: "codex" }).where(eq(agents.id, c.ceo.id));
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "start" });
    await c.scheduler.tick();
    const first = c.starts()[0]!;
    await c.emit({ type: "run.started", runId: first.runId, agentId: c.ceo.id, acpSessionId: "codex-sess", model: null });
    await c.emit({ type: "run.ended", runId: first.runId, stopReason: null, error: "restart", interrupted: true });
    await flush();
    const second = c.starts()[1]!;
    expect(second.resumeSessionId).toBeUndefined();
    expect(second.prompt).toMatch(/interrupted when the runner restarted/);
  });

  it("an ordinary failure is not treated as an interruption", async () => {
    const c = (ctx = await setup());
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "start" });
    await c.scheduler.tick();
    await c.emit({ type: "run.ended", runId: c.starts()[0]!.runId, stopReason: null, error: "the agent gave up on a bad tool answer" });
    await flush();
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "resume"))).toHaveLength(0);
  });

  it("a passing error (model overloaded) is resumed by itself (BOS-2357)", async () => {
    const c = (ctx = await setup());
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "start" });
    await c.scheduler.tick();
    await c.emit({ type: "run.ended", runId: c.starts()[0]!.runId, stopReason: null, error: "model overloaded" });
    await flush();
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "resume"))).toHaveLength(1);
  });
});

describe("MCP writes are safe to repeat after a resume (R42)", () => {
  it("returns the same ticket and the same open decision instead of duplicates", async () => {
    const c = (ctx = await setup());
    const runId = "00000000-0000-4000-8000-000000000001";
    await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.ceo.id });
    const m = await c.mcp(c.ceo.id, runId);
    const one = textOf(await m.callTool({ name: "create_ticket", arguments: { size: 3, title: "Add rate limiting" } }));
    const two = textOf(await m.callTool({ name: "create_ticket", arguments: { size: 3, title: "add rate limiting" } }));
    expect(one).toMatch(/^Created ticket/);
    expect(two).toMatch(/already exists/);
    expect(await c.db.select().from(tickets)).toHaveLength(1);

    const ask = { question: "Which CDN?", options: ["Bunny", "Cloudflare"], recommended: "Bunny", triedFirst: "Looked for a way to do this from the agent run; it has no access to the host or the secret." };
    await m.callTool({ name: "raise_decision", arguments: ask });
    expect(textOf(await m.callTool({ name: "raise_decision", arguments: ask }))).toMatch(/already in the owner's queue/);
    expect(await c.db.select().from(decisions).where(eq(decisions.kind, "question"))).toHaveLength(1);
    await m.close();
  });
});
