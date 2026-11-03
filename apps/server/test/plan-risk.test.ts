import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, deploys, deployTargets, runners, runs, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup(opts: { listen?: boolean; answers?: { verify?: (command: string) => unknown } } = {}) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  let base = "";
  if (opts.listen) {
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  }
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    // Landing first asks what changed; these tickets changed code.
    if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "", truncated: false } }));
    if (c.type === "workspace.verify") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: opts.answers?.verify?.(c.command) ?? { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 } }));
    if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { status: "merged", commit: "c".repeat(40) } }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "No other branch uses this ticket's migration numbers." } }));
    return true;
  });
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event });
  const ticket = async (fields: Record<string, unknown>) => (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, ...fields })).json() as { id: string };
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, req, company, ceo, worker, project, runner: runner!, sent, emit, ticket, mcp };
}

const PLAN = "1. Read the limiter.\n2. Add the window test.";
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

describe("plan-first tickets (R40)", () => {
  it("start in plan mode; the plan goes to the CEO, feedback keeps the agent planning, approval lets it build", async () => {
    const c = await setup();
    const t = await c.ticket({ planFirst: true, state: "ready" });
    await c.db.delete(wakes);
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: "assigned" });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start")!;
    expect(start.mode).toBe("plan");
    expect(start.prompt).toContain("This ticket is plan-first");

    await c.db.delete(wakes);
    await c.emit({ type: "run.permission_request", runId: start.runId, requestId: "p1", title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once", "allow_always", "reject_once"], detail: PLAN });
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect(d).toMatchObject({ tier: "ceo", question: `Engineer's plan for "Add rate limiting": approve it to start building?`, options: ["Approve plan", "Keep planning"] });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.plan).toBe(PLAN);
    // The CEO is woken to answer it.
    expect(await c.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: c.ceo.id, reason: "decision" })]);

    c.sent.length = 0;
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Keep planning", note: "Cover the burst case too." });
    expect(c.sent.map((x) => x.type)).toEqual(["run.message", "permission.decide"]);
    expect(c.sent[0]).toMatchObject({ text: expect.stringContaining("Feedback: Cover the burst case too.") });
    expect(c.sent[1]).toMatchObject({ verdict: "deny" });

    await c.emit({ type: "run.permission_request", runId: start.runId, requestId: "p2", title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once"], detail: `${PLAN}\n3. Burst case.` });
    const [d2] = await c.db.select().from(decisions).where(and(eq(decisions.kind, "approval"), eq(decisions.status, "open")));
    c.sent.length = 0;
    await c.req("POST", `/api/decisions/${d2!.id}/answer`, { answer: "Approve plan" });
    expect(c.sent).toEqual([{ type: "permission.decide", runId: start.runId, requestId: "p2", verdict: "allow" }]);
    const after = (await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!;
    expect(after.planApprovedAt).not.toBeNull();

    // The next run builds from the approved plan, without plan mode.
    await c.db.update(runs).set({ endedAt: new Date() });
    await c.db.delete(wakes);
    c.sent.length = 0;
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: "continue" });
    await c.scheduler.tick();
    const next = c.sent.find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start")!;
    expect(next.mode).toBeUndefined();
    expect(next.prompt).toContain("3. Burst case.");
  });

  it("BOS-371: a reviewer run is never started in plan mode, even on a ticket whose plan isn't approved", async () => {
    const c = await setup();
    const t = await c.ticket({ planFirst: true, state: "review" });
    await c.db.delete(wakes);
    await c.scheduler.wake({ agentId: c.ceo.id, ticketId: t.id, reason: "review requested" });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start");
    expect(start).toBeDefined();
    expect(start!.mode).toBeUndefined();
  });

  it("BOS-371: a plan sent by a reviewer run goes to the CEO as the verdict, not to the owner as a plan card", async () => {
    const c = await setup();
    const t = await c.ticket({ planFirst: true, state: "review" });
    const runId = randomUUID();
    await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId: t.id, origin: "review requested" });
    await c.db.delete(wakes);
    c.sent.length = 0;
    await c.emit({ type: "run.permission_request", runId, requestId: "r1", title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once"], detail: "Security review: approved." });
    expect(await c.db.select().from(decisions).where(eq(decisions.kind, "approval"))).toEqual([]);
    expect(c.sent).toEqual([expect.objectContaining({ type: "permission.decide", requestId: "r1", verdict: "deny" })]);
    expect(await c.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: c.ceo.id, ticketId: t.id })]);
    // The reviewer's text never becomes the ticket's plan.
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.plan).toBeNull();
  });

  it("BOS-371: Keep planning on a later plan card leaves the approved plan approved and unchanged, and says so", async () => {
    const c = await setup();
    const t = await c.ticket({ planFirst: true });
    const at = new Date("2026-11-02T23:15:00Z");
    await c.db.update(tickets).set({ plan: PLAN, planApprovedAt: at }).where(eq(tickets.id, t.id));
    const runId = randomUUID();
    await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId: t.id });
    await c.emit({ type: "run.permission_request", runId, requestId: "k1", title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once"], detail: "A different plan." });
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    c.sent.length = 0;
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Keep planning" });
    const after = (await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!;
    expect(after.planApprovedAt).toEqual(at);
    expect(after.plan).toBe(PLAN);
    expect(c.sent[0]).toMatchObject({ type: "run.message", text: expect.stringContaining("earlier approved plan still stands") });
  });

  it("follows the risk level, with no checkbox: changing the risk before work starts turns it on or off", async () => {
    const c = await setup();
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Rework billing" })).json() as { id: string; planFirst: boolean };
    expect(t.planFirst).toBe(false);
    expect((await c.req("PATCH", `/api/tickets/${t.id}`, { risk: "high" })).json()).toMatchObject({ planFirst: true });
    expect((await c.req("PATCH", `/api/tickets/${t.id}`, { risk: null })).json()).toMatchObject({ planFirst: false });
    expect((await c.req("PATCH", `/api/tickets/${t.id}`, { risk: "critical" })).json()).toMatchObject({ planFirst: true });
    // Once work has started, a new risk level leaves plan mode as it is.
    await c.req("PATCH", `/api/tickets/${t.id}`, { state: "in_progress" });
    expect((await c.req("PATCH", `/api/tickets/${t.id}`, { risk: "low" })).json()).toMatchObject({ planFirst: true });
  });

  it("puts high-risk plans, and the CEO's own, to the owner", async () => {
    const c = await setup();
    const high = await c.ticket({ planFirst: true, risk: "high" });
    const runId = randomUUID();
    await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId: high.id });
    await c.emit({ type: "run.permission_request", runId, requestId: "h1", title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once"], detail: PLAN });
    const ceoRun = randomUUID();
    await c.db.insert(runs).values({ id: ceoRun, companyId: c.company.id, agentId: c.ceo.id });
    // A rule that sends restarts to the CEO doesn't let the CEO approve its own.
    await c.req("POST", "/api/policy-rules", { companyId: c.company.id, name: "Restarts go to the CEO", match: { commandPattern: "restart" }, outcome: "ceo" });
    await c.emit({ type: "run.permission_request", runId: ceoRun, requestId: "c1", title: "docker restart web", kind: "execute", rawInput: { command: "docker restart web" }, optionKinds: ["allow_once"] });
    const rows = await c.db.select().from(decisions);
    expect(rows.map((r) => r.tier)).toEqual(["owner", "owner"]);
  });
});

describe("the CEO answers decisions put to it (R19)", () => {
  it("lists its company's CEO decisions with the plan, answers them, and can't answer for the owner", async () => {
    const c = await setup({ listen: true });
    const t = await c.ticket({ planFirst: true });
    const runId = randomUUID();
    await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId: t.id });
    await c.emit({ type: "run.permission_request", runId, requestId: "p1", title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once"], detail: PLAN });
    const ceo = await c.mcp(c.ceo.id);
    const list = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list" } }));
    expect(list).toContain(`Engineer's plan for "Add rate limiting"`);
    expect(list).toContain("2. Add the window test.");
    const [d] = await c.db.select().from(decisions);
    expect(textOf(await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Approve plan" } }))).toBe("Answered: Approve plan.");
    expect(c.sent.at(-1)).toMatchObject({ type: "permission.decide", verdict: "allow" });

    const worker = await c.mcp(c.worker.id);
    expect(textOf(await worker.callTool({ name: "decisions", arguments: { action: "list" } }))).toBe("No decisions are waiting for you.");
    await ceo.close();
    await worker.close();
  });
});

describe("risk tiers (R48)", () => {
  it("high-risk work runs the deeper check too, and the owner signs off what the CEO approved", async () => {
    const commands: string[] = [];
    const c = await setup({ answers: { verify: (cmd) => (commands.push(cmd), { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 }) } });
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git", verifyCommand: "pnpm test" });
    await c.db.update((await import("../src/db/schema.js")).projects).set({ deepVerifyCommand: "pnpm test:e2e" });
    const t = await c.ticket({ risk: "high", state: "review" });
    const r = await c.review.submit(t.id, { verdict: "approved", reviewer: "CEO", reviewerAgentId: c.ceo.id });
    expect(r).toMatchObject({ verdict: "approved", outcome: "owner_review" });
    expect(c.sent.some((x) => x.type === "workspace.merge")).toBe(false);
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect(d!.question).toBe(`CEO approved "Add rate limiting", which is rated high risk. Merge it, or send it back?`);

    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve and merge" });
    expect(commands).toEqual(["pnpm test", "pnpm test:e2e"]);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]).toMatchObject({ systemState: "done", mergeCommit: "c".repeat(40) });
  });

  it("medium work skips the deeper check and merges on the CEO's approval", async () => {
    const commands: string[] = [];
    const c = await setup({ answers: { verify: (cmd) => (commands.push(cmd), { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 }) } });
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git", verifyCommand: "pnpm test" });
    await c.db.update((await import("../src/db/schema.js")).projects).set({ deepVerifyCommand: "pnpm test:e2e" });
    const t = await c.ticket({ state: "review" });
    expect(await c.review.submit(t.id, { verdict: "approved", reviewer: "CEO", reviewerAgentId: c.ceo.id })).toMatchObject({ outcome: "merged" });
    expect(commands).toEqual(["pnpm test"]);
  });

  it("high-risk work deploys to staging before production", async () => {
    const c = await setup();
    const t = await c.ticket({ risk: "critical" });
    const [staging] = await c.db.insert(deployTargets).values({ companyId: c.company.id, name: "staging", kind: "ssh", endpoint: "deploy@staging" }).returning();
    await c.db.insert(deployTargets).values({ companyId: c.company.id, name: "production", kind: "ssh", endpoint: "deploy@prod", isProduction: true });
    const actor = { companyId: c.company.id, agentId: c.worker.id };
    await expect(c.deploys.request(actor, { target: "production", ref: "v1.4.0", ticketId: t.id })).rejects.toThrow(
      "This ticket is rated critical risk, so v1.4.0 has to deploy to staging first. Deploy it to staging, then ask for production again.",
    );
    await c.db.insert(deploys).values({ companyId: c.company.id, targetId: staging!.id, ticketId: t.id, ref: "v1.4.0", status: "succeeded" });
    const ok = await c.deploys.request(actor, { target: "production", ref: "v1.4.0", ticketId: t.id });
    expect(ok.note).toMatch(/Waiting for the owner/);
  });
});
