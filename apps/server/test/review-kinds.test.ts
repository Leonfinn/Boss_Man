import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy, type RunnerCommand, type RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, reviewRequests, runners, runs, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const DIFF = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [], files: [], diff: "diff --git a/x b/x", truncated: false };
const PLAN = "1. Read the limiter.";
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  ctx = { close: async () => (await Promise.all(clients.map((c) => c.close())), await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const other = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Designer" })).json();
  const [senior] = await db.insert(agents).values({ companyId: company.id, name: "Sam", role: "worker", agentKind: "claude", title: "Senior Developer", template: "senior-dev" }).returning();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") ok(DIFF);
    if (c.type === "workspace.verify") ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
    if (c.type === "workspace.merge") ok({ status: "merged", commit: "c".repeat(40) });
    return true;
  });
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event });
  const ticket = async (fields: Record<string, unknown> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, ...fields })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
    return t;
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const setPolicy = (mut: (p: ReviewPolicy) => void) => {
    const p = structuredClone(DEFAULT_REVIEW_POLICY);
    mut(p);
    return req("PUT", `/api/companies/${company.id}/review-policy`, p);
  };
  /** A plan from the worker's run on the ticket. */
  const plan = async (ticketId: string, requestId = "p1") => {
    const runId = randomUUID();
    await db.insert(runs).values({ id: runId, companyId: company.id, agentId: worker.id, ticketId });
    await emit({ type: "run.permission_request", runId, requestId, title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once"], detail: PLAN });
    return (await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`)))[0]!;
  };
  return { ...built, db, req, company, ceo, worker, other, senior: senior!, project, ticket, row, mcp, setPolicy, plan, sent };
}


async function kinds() {
  const c = await setup();
  const [sec] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Sec", role: "worker", agentKind: "claude", title: "Security Reviewer" }).returning();
  const [infra] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Ivy", role: "worker", agentKind: "claude", title: "Infra" }).returning();
  await c.req("PATCH", `/api/agents/${infra!.id}`, { reviewKind: "infra" });
  // Medium needs a security review (by id) and an infra review (by whoever is marked).
  await c.setPolicy((p) => (p.medium.kinds = { security: sec!.id, infra: "marked" }));
  const t = await c.ticket({ state: "review" });
  await c.db.delete(wakes);
  await c.scheduler.onTicketReview(t.id, c.worker.id);
  const rows = () => c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id)).orderBy(reviewRequests.round, reviewRequests.kind);
  const call = async (agentId: string, args: Record<string, unknown>) => textOf(await (await c.mcp(agentId)).callTool({ name: "review", arguments: { ticketId: t.id, ...args } }));
  const woken = async () => {
    const w = (await c.db.select().from(wakes)).map((x) => x.agentId);
    await c.db.delete(wakes);
    return w;
  };
  return { ...c, sec: sec!, infra: infra!, t, rows, call, woken };
}

describe("review kinds", () => {
  it("requests every required review at once, each reviewer woken", async () => {
    const c = await kinds();
    expect((await c.rows()).map((r) => [r.kind, r.reviewerAgentId, r.round, r.status])).toEqual([
      ["code", c.senior.id, 1, "pending"],
      ["infra", c.infra.id, 1, "pending"],
      ["security", c.sec.id, 1, "pending"],
    ]);
    expect((await c.woken()).sort()).toEqual([c.senior.id, c.infra.id, c.sec.id].sort());
    // Entering review again without an answer starts round 2 and drops the unanswered one.
    await c.scheduler.onTicketReview(c.t.id, c.worker.id);
    expect((await c.rows()).map((r) => [r.round, r.status])).toEqual([[1, "skipped"], [1, "skipped"], [1, "skipped"], [2, "pending"], [2, "pending"], [2, "pending"]]);
  });

  it("passes only when all approve", async () => {
    const c = await kinds();
    expect(await c.call(c.senior.id, { action: "submit", verdict: "approved" })).toContain("waiting for the other reviews");
    expect(await c.call(c.sec.id, { action: "submit", verdict: "approved" })).toContain("waiting");
    expect((await c.row(c.t.id)).systemState).toBe("review");
    expect(await c.call(c.infra.id, { action: "submit", verdict: "approved" })).toBe("Approved; the ticket is done.");
    expect((await c.row(c.t.id)).systemState).toBe("done");
  });

  it("sends the work back once everyone has answered if one asks for changes", async () => {
    const c = await kinds();
    await c.call(c.senior.id, { action: "submit", verdict: "approved" });
    await c.call(c.sec.id, { action: "submit", verdict: "changes_requested", summary: "Escape the filter." });
    expect((await c.row(c.t.id)).systemState).toBe("review");
    expect(await c.call(c.infra.id, { action: "submit", verdict: "approved" })).toContain("Changes requested");
    expect((await c.row(c.t.id)).systemState).toBe("in_progress");
    expect((await c.woken())).toContain(c.worker.id);
    // The same reviewers review again in round 2.
    await c.db.delete(wakes);
    await c.scheduler.onTicketReview(c.t.id, c.worker.id);
    expect((await c.rows()).filter((r) => r.round === 2).map((r) => r.kind)).toEqual(["code", "infra", "security"]);
    expect((await c.woken()).sort()).toEqual([c.senior.id, c.infra.id, c.sec.id].sort());
  });

  it("lets the CEO order the reviews; a later one waits its turn", async () => {
    const c = await kinds();
    await c.woken();
    expect(await c.call(c.worker.id, { action: "sequence", order: ["infra", "security"] })).toBe("You can't review a ticket assigned to you.");
    expect(await c.call(c.sec.id, { action: "sequence", order: ["infra", "security"] })).toBe("Only your company's CEO can do that.");
    expect(await c.call(c.ceo.id, { action: "sequence", order: ["infra", "security"] })).toContain("infra, then security");
    expect((await c.db.select().from(activity).where(eq(activity.ticketId, c.t.id))).map((a) => a.summary)).toContain("Reviews run in this order: infra, then security");
    expect(await c.call(c.sec.id, { action: "submit", verdict: "approved" })).toContain("Not yet");
    await c.call(c.infra.id, { action: "submit", verdict: "approved" });
    // Infra done: security is woken for its turn.
    expect(await c.woken()).toEqual([c.sec.id]);
    expect(await c.call(c.sec.id, { action: "submit", verdict: "approved" })).toContain("waiting");
  });

  it("applies a stored order to the next request, and a failed earlier review stops the later one", async () => {
    const c = await kinds();
    await c.call(c.ceo.id, { action: "sequence", order: ["infra", "security"] });
    await c.call(c.infra.id, { action: "submit", verdict: "changes_requested", summary: "No rollback." });
    await c.call(c.senior.id, { action: "submit", verdict: "approved" });
    expect((await c.row(c.t.id)).systemState).toBe("in_progress");
    expect((await c.rows()).find((r) => r.kind === "security")!.status).toBe("skipped");
    await c.db.delete(wakes);
    await c.scheduler.onTicketReview(c.t.id, c.worker.id);
    expect((await c.rows()).filter((r) => r.round === 2).map((r) => [r.kind, r.seq])).toEqual([["code", 0], ["infra", 1], ["security", 2]]);
    expect((await c.woken()).sort()).toEqual([c.senior.id, c.infra.id].sort());
  });

  it("lets the CEO overrule changes requested, with a reason on the ticket", async () => {
    const c = await kinds();
    await c.call(c.senior.id, { action: "submit", verdict: "approved" });
    await c.call(c.infra.id, { action: "submit", verdict: "approved" });
    await c.call(c.sec.id, { action: "submit", verdict: "changes_requested", summary: "Pen test it." });
    expect((await c.row(c.t.id)).systemState).toBe("in_progress");
    expect(await c.call(c.sec.id, { action: "overrule", kind: "security", reason: "x" })).toBe("Only your company's CEO can do that.");
    expect(await c.call(c.ceo.id, { action: "overrule", kind: "infra", reason: "no" })).toContain("no infra review asking for changes");
    expect(await c.call(c.ceo.id, { action: "overrule", kind: "security", reason: "Out of scope for this ticket." })).toContain("Approved; the ticket is done.");
    expect((await c.row(c.t.id)).systemState).toBe("done");
    const listed = (await c.req("GET", `/api/tickets/${c.t.id}/reviews`)).json() as Array<{ kind: string; status: string; overruleReason: string | null; reviewer: string }>;
    expect(listed.find((r) => r.kind === "security")).toMatchObject({ status: "overruled", overruleReason: "Out of scope for this ticket.", reviewer: "Sec" });
    expect((await c.db.select().from(activity).where(eq(activity.ticketId, c.t.id))).map((a) => a.summary)).toContain("The CEO overruled the security review's changes requested: Out of scope for this ticket.");
  });

  it("cannot overrule its way past the owner's sign-off", async () => {
    const c = await kinds();
    await c.setPolicy((p) => {
      p.high.kinds = { security: c.sec.id };
      p.high.ownerSignoff = true;
    });
    const t = await c.ticket({ state: "review", risk: "high" });
    await c.scheduler.onTicketReview(t.id, c.worker.id);
    const call = async (agentId: string, args: Record<string, unknown>) => textOf(await (await c.mcp(agentId)).callTool({ name: "review", arguments: { ticketId: t.id, ...args } }));
    await call(c.senior.id, { action: "submit", verdict: "approved" });
    await call(c.sec.id, { action: "submit", verdict: "changes_requested", summary: "Fix auth." });
    expect(await call(c.ceo.id, { action: "overrule", kind: "security", reason: "Handled elsewhere." })).toContain("the owner signs it off");
    expect((await c.row(t.id)).systemState).not.toBe("done");
    expect((await c.db.select().from(decisions).where(eq(decisions.kind, "approval"))).some((d) => d.tier === "owner" && d.question.includes("rated high risk"))).toBe(true);
  });

  it("falls back to the CEO, with a note, when the marked reviewer is missing", async () => {
    const c = await kinds();
    await c.db.update(agents).set({ reviewKind: null }).where(eq(agents.id, c.infra.id));
    const t = await c.ticket({ state: "review" });
    await c.scheduler.onTicketReview(t.id, c.worker.id);
    const mine = (await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id))).find((r) => r.kind === "infra")!;
    expect(mine.reviewerAgentId).toBe(c.ceo.id);
    expect((await c.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((a) => a.summary)).toContain("No infra reviewer is marked, so the CEO reviews it");
  });

  it("marking an agent moves the mark from whoever had it", async () => {
    const c = await kinds();
    await c.req("PATCH", `/api/agents/${c.other.id}`, { reviewKind: "infra" });
    const marked = (await c.db.select().from(agents).where(eq(agents.reviewKind, "infra"))).map((a) => a.id);
    expect(marked).toEqual([c.other.id]);
  });

  it("escalates to the owner when the fourth round still asks for changes", async () => {
    const c = await kinds();
    for (let round = 1; round <= 4; round++) {
      if (round > 1) await c.scheduler.onTicketReview(c.t.id, c.worker.id);
      await c.call(c.senior.id, { action: "submit", verdict: "approved" });
      await c.call(c.infra.id, { action: "submit", verdict: "approved" });
      await c.call(c.sec.id, { action: "submit", verdict: "changes_requested", summary: `Round ${round} finding.` });
      if (round < 4) expect((await c.row(c.t.id)).systemState).toBe("in_progress");
    }
    expect((await c.row(c.t.id)).systemState).toBe("blocked");
    expect((await c.db.select().from(decisions)).some((d) => (d.context as { type?: string }).type === "review_loop")).toBe(true);
    expect(await c.call(c.ceo.id, { action: "overrule", kind: "security", reason: "Enough." })).toBe("That ticket is waiting on a decision from the owner.");
  });

  it("uses the project's own policy over the company's", async () => {
    const c = await setup();
    const sec = (await c.db.insert(agents).values({ companyId: c.company.id, name: "Sec", role: "worker", agentKind: "claude" }).returning())[0]!;
    const p = structuredClone(DEFAULT_REVIEW_POLICY);
    p.medium.kinds = { security: sec.id };
    expect((await c.req("PUT", `/api/projects/${c.project.id}/review-policy`, p)).statusCode).toBe(200);
    const t = await c.ticket({ state: "review" });
    await c.scheduler.onTicketReview(t.id, c.worker.id);
    expect((await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id))).map((r) => r.kind).sort()).toEqual(["code", "security"]);
    await c.req("DELETE", `/api/projects/${c.project.id}/review-policy`);
    const t2 = await c.ticket({ state: "review" });
    await c.scheduler.onTicketReview(t2.id, c.worker.id);
    expect((await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t2.id))).map((r) => r.kind)).toEqual(["code"]);
  });

  it("refuses a policy that names another company's agent for a kind", async () => {
    const c = await setup();
    const rival = (await c.req("POST", "/api/companies", { name: "Rival Co" })).json();
    const p = structuredClone(DEFAULT_REVIEW_POLICY);
    p.low.kinds = { infra: rival.ceo.id };
    expect((await c.req("PUT", `/api/companies/${c.company.id}/review-policy`, p)).statusCode).toBe(400);
  });
});
