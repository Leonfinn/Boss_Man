import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ownerChatTraces, runners } from "../src/db/schema.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

type Start = Extract<RunnerCommand, { type: "run.start" }>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  return { ...built, db, req, company, ceo, worker, sent, emit, settle };
}

describe("Thinking trace in the owner chat (BOS-1368)", () => {
  it("stores each reply's steps and returns them on reload, redacted and in order", async () => {
    const c = await setup();
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "What did the team do?" });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    await c.emit({ type: "run.started", runId: start.runId, agentId: c.ceo.id, acpSessionId: "s1", model: "m" });
    // A thought, a look, a command whose output has a fake secret in it.
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "reasoning", text: "Let me read the ticket first." } });
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "tool_call", toolCallId: "c1", title: "mcp__bossman__tickets", traceKind: "look", inputSummary: "BOS-12", resultSummary: "BOS-12 · Build the loader", status: "completed" } });
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "tool_call", toolCallId: "c2", title: "bash", toolKind: "execute", traceKind: "command", inputSummary: "pnpm test", resultSummary: "ok; GIT_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123", status: "completed" } });
    await c.settle();

    // While the run is working, the live trace is on the chat response.
    const live = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json();
    expect(live.state).toBe("answering");
    expect(live.live).toBeTruthy();
    expect(live.live.steps.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(live.live)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");

    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: "Here is what the team did." } });
    await c.emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null });
    await c.settle();

    const chat = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json();
    const reply = chat.items.filter((m: { role: string }) => m.role === "assistant").at(-1) as { trace?: { steps: Array<{ kind: string; summary: string }> } };
    expect(reply.trace).toBeTruthy();
    expect(reply.trace!.steps.map((s) => s.kind)).toEqual(["reasoning", "look", "command"]);
    // The fake token in the command's output never reached the stored trace or the response.
    expect(JSON.stringify(chat)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    // It is in the database, not rebuilt on read.
    const rows = await c.db.select().from(ownerChatTraces).where(eq(ownerChatTraces.companyId, c.company.id));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.trace)).not.toContain("ghp_");
  });

  it("saves no trace for a reply with no steps, and shows a worker's trace too", async () => {
    const c = await setup();
    // A short reply from the CEO with no steps: no trace row, no trace on the item.
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Hi" });
    await c.scheduler.tick();
    const ceoStart = c.sent.find((x): x is Start => x.type === "run.start")!;
    await c.emit({ type: "run.started", runId: ceoStart.runId, agentId: c.ceo.id, acpSessionId: "s1", model: "m" });
    await c.emit({ type: "run.update", runId: ceoStart.runId, update: { kind: "agent_message", text: "Hello!" } });
    await c.emit({ type: "run.ended", runId: ceoStart.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const ceoChat = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json();
    const ceoReply = ceoChat.items.filter((m: { role: string }) => m.role === "assistant").at(-1) as { trace?: unknown };
    expect(ceoReply.trace).toBeUndefined();
    expect(await c.db.select().from(ownerChatTraces)).toHaveLength(0);

    // A worker messaged directly gets a trace the same way (same chat view, same route).
    c.sent.length = 0;
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "What are you on?", agentId: c.worker.id });
    await c.scheduler.tick();
    const wStart = c.sent.find((x): x is Start => x.type === "run.start")!;
    expect(wStart.agentId).toBe(c.worker.id);
    await c.emit({ type: "run.started", runId: wStart.runId, agentId: c.worker.id, acpSessionId: "s2", model: "m" });
    await c.emit({ type: "run.update", runId: wStart.runId, update: { kind: "tool_call", toolCallId: "c1", title: "read_file", traceKind: "look", inputSummary: "src/x.ts", status: "completed" } });
    await c.emit({ type: "run.update", runId: wStart.runId, update: { kind: "agent_message", text: "Reading a file." } });
    await c.emit({ type: "run.ended", runId: wStart.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const workerChat = (await c.req("GET", `/api/companies/${c.company.id}/chat?agentId=${c.worker.id}`)).json();
    const workerReply = workerChat.items.filter((m: { role: string }) => m.role === "assistant").at(-1) as { trace?: { steps: unknown[] } };
    expect(workerReply.trace?.steps).toHaveLength(1);
  });

  it("keeps one company's traces out of another's chat", async () => {
    const c = await setup();
    const other = (await c.req("POST", "/api/companies", { name: "Other Co" })).json();
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Hi" });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    await c.emit({ type: "run.started", runId: start.runId, agentId: c.ceo.id, acpSessionId: "s1", model: "m" });
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "tool_call", toolCallId: "c1", title: "mcp__bossman__tickets", traceKind: "look", inputSummary: "secret-bos", status: "completed" } });
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: "Done." } });
    await c.emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const otherChat = (await c.req("GET", `/api/companies/${other.id}/chat`)).json();
    expect(JSON.stringify(otherChat)).not.toContain("secret-bos");
  });
});
