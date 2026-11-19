import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, companies, costEvents, decisions, fundingSources, runners, runs, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  let release = built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  const offline = () => release();
  const online = () => (release = built.runners.connect(reg.runnerId, (c) => (sent.push(c), true)));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
  // A running run for the worker.
  await built.scheduler.wake({ agentId: worker.id, reason: "start" });
  await built.scheduler.tick();
  const start = sent.find((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start")!;
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: start.runId });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, req, company, ceo, worker, sent, offline, online, emit, runId: start.runId, mcp };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("steering runs (R37)", () => {
  it("sends the owner's message into a running agent, with or without interrupting", async () => {
    const c = (ctx = await setup());
    expect((await c.req("GET", "/api/runs")).json()).toEqual([expect.objectContaining({ id: c.runId, agent: "Engineer" })]);
    expect((await c.req("POST", `/api/runs/${c.runId}/message`, { text: "Use the staging DB" })).json()).toEqual({ delivered: "queued" });
    expect(c.sent.at(-1)).toEqual({ type: "run.message", runId: c.runId, text: "Message from the owner: Use the staging DB", interrupt: false });
    expect((await c.req("POST", `/api/runs/${c.runId}/message`, { text: "Stop, wrong repo", interrupt: true })).json()).toEqual({ delivered: "interrupted" });
    expect(c.sent.at(-1)).toMatchObject({ interrupt: true });
  });

  it("wakes the agent again when the run has ended, and refuses when the runner is offline", async () => {
    const c = (ctx = await setup());
    c.offline();
    const off = await c.req("POST", `/api/runs/${c.runId}/message`, { text: "hello" });
    expect(off.statusCode).toBe(409);
    expect(off.json().message).toMatch(/offline/);
    c.online();
    await c.emit({ type: "run.ended", runId: c.runId, stopReason: "end_turn", error: null });
    await c.db.delete(wakes);
    expect((await c.req("POST", `/api/runs/${c.runId}/message`, { text: "One more thing: update the changelog" })).json()).toEqual({ delivered: "woken" });
    expect(await c.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: c.worker.id, reason: "message", note: "Message from the owner: One more thing: update the changelog" })]);
    expect((await c.req("POST", `/api/runs/${c.runId}/cancel`)).statusCode).toBe(409);
  });

  it("stops a run", async () => {
    const c = (ctx = await setup());
    expect((await c.req("POST", `/api/runs/${c.runId}/cancel`)).json()).toEqual({ cancelled: true });
    expect(c.sent.at(-1)).toEqual({ type: "run.cancel", runId: c.runId });
  });

  it("lets only the CEO steer through MCP", async () => {
    const c = (ctx = await setup());
    const asWorker = await c.mcp(c.worker.id);
    expect(textOf(await asWorker.callTool({ name: "runs", arguments: { action: "list" } }))).toBe("Only your company's CEO can steer runs.");
    await asWorker.close();
    const asCeo = await c.mcp(c.ceo.id);
    const list = JSON.parse(textOf(await asCeo.callTool({ name: "runs", arguments: { action: "list" } })));
    expect(list[0]).toMatchObject({ id: c.runId });
    await asCeo.close();
  });
});

describe("finished-run history through MCP", () => {
  it("gives the CEO and the Data & Analytics agent finished runs, refuses others, and stays in the company", async () => {
    const c = (ctx = await setup());
    const [analyst] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Moony", role: "worker", agentKind: "claude", template: "data-analytics" }).returning();
    const [other] = await c.db.insert(companies).values({ name: "Other Co" }).returning();
    const at = new Date(Date.now() - 3_600_000);
    // The live run c.runId keeps the MCP tokens working (a token dies with its run), so the finished run is a separate row.
    const [finished] = await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.worker.id, startedAt: at, endedAt: new Date(at.getTime() + 90_000), outcome: "done", model: "m1", inputTokens: 10, cachedReadTokens: 500, cachedWriteTokens: 70 }).returning();
    const [src] = await c.db.insert(fundingSources).values({ name: "Test source", kind: "api_payg", provider: "anthropic" }).returning();
    for (const costMicros of [1_500_000, 250_000]) await c.db.insert(costEvents).values({ runId: finished!.id, fundingSourceId: src!.id, companyId: c.company.id, costMicros });
    await c.db.insert(runs).values({ companyId: other!.id, startedAt: at, endedAt: new Date(), outcome: "done" });
    const hist = (args: object) => ({ name: "runs", arguments: { action: "history", ...args } });

    const asWorker = await c.mcp(c.worker.id);
    expect(textOf(await asWorker.callTool(hist({})))).toMatch(/Only your company's CEO or its Data & Analytics agent/);
    await asWorker.close();

    for (const id of [c.ceo.id, analyst!.id]) {
      const m = await c.mcp(id);
      const rows = JSON.parse(textOf(await m.callTool(hist({}))));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: finished!.id, agent: "Engineer", model: "m1", outcome: "done", seconds: 90, inputTokens: 10, outputTokens: null, cachedReadTokens: 500, cachedWriteTokens: 70, costMicros: 1_750_000 });
      expect(Object.keys(rows[0]).sort()).toEqual(["agent", "cachedReadTokens", "cachedWriteTokens", "costMicros", "endedAt", "id", "inputTokens", "model", "origin", "outcome", "outputTokens", "seconds", "startedAt", "stopReason", "ticket"]);
      await m.close();
    }
    const m = await c.mcp(analyst!.id);
    expect(textOf(await m.callTool(hist({ from: "2020-01-01", to: "2020-03-01" })))).toBe("Ask for at most 14 days at a time.");
    expect(textOf(await m.callTool(hist({ from: "2020-01-01", to: "2020-01-02" })))).toBe("[]");
    expect(textOf(await m.callTool({ name: "runs", arguments: { action: "list" } }))).toBe("Only your company's CEO can steer runs.");
    await m.close();
  });
});

describe("undelivered permission verdicts (R22)", () => {
  it("flags an answer the runner couldn't receive, and re-sends it when the runner returns", async () => {
    const c = (ctx = await setup());
    await c.emit({ type: "run.permission_request", runId: c.runId, requestId: "req-1", title: "git push", kind: "execute", rawInput: { command: "git push origin main" }, optionKinds: ["allow_once", "reject_once"] });
    const [perm] = await c.db.select().from(decisions).where(eq(decisions.kind, "permission"));
    c.offline();
    await c.req("POST", `/api/decisions/${perm!.id}/answer`, { answer: "Allow once" });
    const alerts = (await c.db.select().from(decisions)).filter((d) => d.kind === "question");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.question).toMatch(/couldn't reach the company's runner/);
    expect(((await c.db.select().from(decisions).where(eq(decisions.id, perm!.id)))[0]!.context as { delivered?: boolean }).delivered).toBe(false);

    c.online();
    await new Promise((r) => setTimeout(r, 50));
    expect(c.sent.at(-1)).toEqual({ type: "permission.decide", runId: c.runId, requestId: "req-1", verdict: "allow" });
    expect(((await c.db.select().from(decisions).where(eq(decisions.id, perm!.id)))[0]!.context as { delivered?: boolean }).delivered).toBe(true);
  });
});

describe("permission cards whose run has ended (BOS-342)", () => {
  const request = (runId: string) => ({ type: "run.permission_request" as const, runId, requestId: "req-1", title: "git push", kind: "execute" as const, rawInput: { command: "git push origin main" }, optionKinds: ["allow_once", "reject_once"] });

  it("takes an open card off the owner's queue by itself when its run ends, with a plain note", async () => {
    const c = (ctx = await setup());
    await c.emit(request(c.runId));
    const [perm] = await c.db.select().from(decisions).where(eq(decisions.kind, "permission"));
    expect(perm!.status).toBe("open");
    await c.emit({ type: "run.ended", runId: c.runId, stopReason: "end_turn", error: null });
    await new Promise((r) => setTimeout(r, 50));
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, perm!.id));
    expect(after!.status, JSON.stringify(after!.context)).toBe("withdrawn");
    expect((after!.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/agent finished/);
  });

  it("answering such a card never errors and doesn't raise an 'offline runner' alarm", async () => {
    const c = (ctx = await setup());
    await c.emit(request(c.runId));
    const [perm] = await c.db.select().from(decisions).where(eq(decisions.kind, "permission"));
    // The run has ended in the database, but the card is still open (the end event was missed).
    await c.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.id, c.runId));
    c.offline();
    const res = await c.req("POST", `/api/decisions/${perm!.id}/answer`, { answer: "Allow once" });
    expect(res.statusCode).toBe(200);
    expect((await c.db.select().from(decisions)).filter((d) => d.kind === "question")).toHaveLength(0);
    expect(((await c.db.select().from(decisions).where(eq(decisions.id, perm!.id)))[0]!.context as { delivered?: unknown }).delivered).toBe("run_ended");
  });
});
