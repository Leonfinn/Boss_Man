import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy, type RunnerCommand, type RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, runners, runs, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { resolveReviewer } from "../src/services/review-policy.js";
import { raiseMergeStuck } from "../src/services/decisions.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const DIFF = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "x", added: 1, removed: 0 }], diff: "diff --git a/x b/x", truncated: false };
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
  /** Set to make the runner's merge fail, as when it drops off mid-way. */
  const faults: { merge: boolean; changed: boolean; holdMerge: Promise<void> | null } = { merge: false, changed: false, holdMerge: null };
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") ok(faults.changed ? { ...DIFF, files: [{ path: "src/a.ts", added: 1, removed: 0 }] } : DIFF);
    if (c.type === "workspace.verify") ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
    if (c.type === "workspace.merge" && faults.merge) queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: false, error: "The runner went away" }));
    else if (c.type === "workspace.merge") void (faults.holdMerge ?? Promise.resolve()).then(() => ok({ status: "merged", commit: "c".repeat(40) }));
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
  return { ...built, db, req, company, ceo, worker, other, senior: senior!, project, ticket, row, mcp, setPolicy, plan, sent, faults };
}

describe("who the policy names", () => {
  it("resolves the symbolic senior developer to the hired one, else the CEO", async () => {
    const c = await setup();
    const t = await c.row((await c.ticket()).id);
    expect((await resolveReviewer(c.db, t)).agent?.id).toBe(c.senior.id);
    await c.db.update(agents).set({ retiredAt: new Date() }).where(eq(agents.id, c.senior.id));
    // None hired is the default's normal case: the CEO, with no outage note.
    expect(await resolveReviewer(c.db, t)).toEqual({ agent: { id: c.ceo.id, name: expect.any(String) }, note: null });
  });

  it("lets a project override beat the company's", async () => {
    const c = await setup();
    const t = await c.row((await c.ticket()).id);
    const p = structuredClone(DEFAULT_REVIEW_POLICY);
    p.medium.reviewer = c.other.id;
    expect((await c.req("PUT", `/api/projects/${c.project.id}/review-policy`, p)).statusCode).toBe(200);
    expect((await resolveReviewer(c.db, t)).agent?.id).toBe(c.other.id);
    expect((await c.req("DELETE", `/api/projects/${c.project.id}/review-policy`)).json()).toEqual({ policy: null });
    expect((await resolveReviewer(c.db, t)).agent?.id).toBe(c.senior.id);
  });
});

describe("review wake", () => {
  it("goes to the medium-tier reviewer, and to the CEO for a low-tier ticket", async () => {
    const c = await setup();
    const med = await c.ticket();
    await c.db.delete(wakes);
    await c.scheduler.onTicketReview(med.id, c.worker.id);
    expect((await c.db.select().from(wakes)).map((w) => [w.agentId, w.reason])).toEqual([[c.senior.id, "review requested"]]);
    const low = await c.ticket({ risk: "low" });
    await c.db.delete(wakes);
    await c.scheduler.onTicketReview(low.id, c.worker.id);
    expect((await c.db.select().from(wakes)).map((w) => w.agentId)).toEqual([c.ceo.id]);
  });

  it("falls back to the CEO, with a note on the ticket, when the reviewer is paused, missing or the assignee", async () => {
    const c = await setup();
    const t = await c.ticket();
    const wakeTarget = async () => {
      await c.db.delete(wakes);
      await c.scheduler.onTicketReview(t.id, c.worker.id);
      return (await c.db.select().from(wakes)).map((w) => w.agentId);
    };
    await c.db.update(agents).set({ paused: true }).where(eq(agents.id, c.senior.id));
    expect(await wakeTarget()).toEqual([c.ceo.id]);
    expect((await c.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((a) => a.summary)).toContain("Sam is unavailable, so the CEO reviews it");
    await c.db.update(agents).set({ paused: false }).where(eq(agents.id, c.senior.id));
    expect(await wakeTarget()).toEqual([c.senior.id]);
    await c.db.update(tickets).set({ assigneeAgentId: c.senior.id }).where(eq(tickets.id, t.id));
    expect(await wakeTarget()).toEqual([c.ceo.id]);
    // A named agent that is gone: the policy is stored with its id, then the agent is retired.
    await c.db.update(tickets).set({ assigneeAgentId: c.worker.id }).where(eq(tickets.id, t.id));
    await c.setPolicy((p) => (p.medium.reviewer = c.other.id));
    await c.db.update(agents).set({ retiredAt: new Date() }).where(eq(agents.id, c.other.id));
    expect(await wakeTarget()).toEqual([c.ceo.id]);
    expect((await c.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((a) => a.summary)).toContain("Designer is unavailable, so the CEO reviews it");
  });

  it("never sends the CEO's own work back to the CEO: the senior developer reviews it", async () => {
    const c = await setup();
    const t = await c.ticket({ risk: "low" });
    await c.db.update(tickets).set({ assigneeAgentId: c.ceo.id }).where(eq(tickets.id, t.id));
    expect(await resolveReviewer(c.db, await c.row(t.id))).toEqual({ agent: { id: c.senior.id, name: "Sam" }, note: "The CEO did this work, so Sam reviews it" });
    await c.db.update(agents).set({ paused: true }).where(eq(agents.id, c.senior.id));
    expect(await resolveReviewer(c.db, await c.row(t.id))).toEqual({ agent: null, note: "The CEO did this work and no other agent can review it, so it waits for the owner" });
  });
});

describe("an approval whose merge fails", () => {
  it("tells the owner how to fix a token that can't change CI files", async () => {
    const c = await setup();
    const t = await c.ticket();
    const [d] = await raiseMergeStuck(c.db, await c.row(t.id), "! [remote rejected] HEAD -> main (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)");
    const [row] = await c.db.select().from(decisions).where(eq(decisions.id, d!.id));
    expect(row!.question).toContain("Workflows to Read and write");
    const [other] = await raiseMergeStuck(c.db, await c.row((await c.ticket()).id), "The runner went away");
    expect((await c.db.select().from(decisions).where(eq(decisions.id, other!.id)))[0]!.question).not.toContain("Workflows");
  });
  it("says so on the ticket and asks the owner, instead of leaving it in review with nothing pending", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.scheduler.onTicketReview(t.id, c.worker.id);
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    c.faults.merge = true;
    c.faults.changed = true;
    const senior = await c.mcp(c.senior.id);
    const out = textOf(await senior.callTool({ name: "review", arguments: { action: "submit", ticketId: t.id, verdict: "approved" } }));
    // The reviewer is told at once that it lands in the background, so a 300 s client timeout can't drop it.
    expect(out).toContain("being checked and merged in the background");
    await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${t.id}/landing`)).json().landing.state).toBe("finished"));
    expect((await c.row(t.id)).systemState).toBe("review");
    expect((await c.db.select().from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "merge_failed"))))[0]?.summary).toBe("Approved, but the merge couldn't run: The runner went away");
    const [d] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `merge-stuck:${t.id}`));
    expect(d).toMatchObject({ status: "open", tier: "owner", options: ["Run the check again", "Send it back to the agent"] });
    // It holds up the approved ticket, so it ranks above a question that blocks nothing.
    const queued = (await c.req("GET", "/api/decisions")).json() as Array<{ id: string; blocks: Array<{ ticketId: string }>; score: number }>;
    expect(queued.find((x) => x.id === d!.id)).toMatchObject({ blocks: [expect.objectContaining({ ticketId: t.id })], score: expect.any(Number) });
    expect(queued.find((x) => x.id === d!.id)!.score).toBeGreaterThan(0);

    // Trying again once the runner is back merges it. While that merge runs (held here, as a long
    // check would), the ticket counts as active, so the sweep doesn't ask about it again.
    c.faults.merge = false;
    let release!: () => void;
    c.faults.holdMerge = new Promise<void>((r) => (release = r));
    await c.db.update(tickets).set({ lastActivityAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(tickets.id, t.id));
    const merges = c.sent.filter((x) => x.type === "workspace.merge").length;
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Run the check again" });
    await vi.waitFor(() => expect(c.sent.filter((x) => x.type === "workspace.merge").length).toBeGreaterThan(merges));
    expect(await c.sweeps.run()).toMatchObject({ unmergedApprovals: 0 });
    release();
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));

    // An older ask answered after the merge runs nothing again: no check, no second merge.
    await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${t.id}/landing`)).json().landing.state).toBe("finished"));
    const [late] = await c.db.insert(decisions).values({ companyId: (await c.row(t.id)).companyId, kind: "question", question: "stale", options: ["Run the check again", "Send it back to the agent"], recommendedOption: "Run the check again", tier: "owner", context: { type: "check_stuck", ticketId: t.id, command: "pnpm test" } }).returning();
    const before = c.sent.length;
    await c.req("POST", `/api/decisions/${late!.id}/answer`, { answer: "Run the check again" });
    await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${t.id}/landing`)).json().landing).toMatchObject({ state: "finished", outcome: "done" }));
    expect(c.sent.slice(before).filter((x) => x.type.startsWith("workspace."))).toEqual([]);
    expect((await c.row(t.id)).systemState).toBe("done");
  });
});

describe("the review tool", () => {
  it("allows the CEO and the ticket's reviewer, refuses another worker and the assignee", async () => {
    const c = await setup();
    const t = await c.ticket({ state: "review" });
    const call = async (agentId: string) => textOf(await (await c.mcp(agentId)).callTool({ name: "review", arguments: { action: "diff", ticketId: t.id } }));
    expect(await call(c.senior.id)).toContain("Base ");
    expect(await call(c.ceo.id)).toContain("Base ");
    expect(await call(c.other.id)).toBe("Only your company's CEO or this ticket's reviewer reviews it.");
    expect(await call(c.worker.id)).toBe("You can't review a ticket assigned to you.");
  });

  it("labels the reviewer with name and title, and sign-off decides between an owner decision and a merge", async () => {
    const c = await setup();
    const t = await c.ticket({ state: "review" });
    const senior = await c.mcp(c.senior.id);
    const submit = async (ticketId: string) => textOf(await senior.callTool({ name: "review", arguments: { action: "submit", ticketId, verdict: "approved" } }));
    // Medium: no sign-off by default, so it merges.
    expect(await submit(t.id)).toContain("being checked and merged in the background");
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    // Turn sign-off on for medium: the owner is asked instead.
    await c.setPolicy((p) => (p.medium.ownerSignoff = true));
    const t2 = await c.ticket({ state: "review" });
    expect(await submit(t2.id)).toContain("the owner signs it off before it merges");
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect(d).toMatchObject({ tier: "owner", question: expect.stringContaining("Sam (Senior Developer) approved") });
    // And a high ticket with sign-off switched off merges without asking.
    await c.setPolicy((p) => (p.high.ownerSignoff = false));
    const t3 = await c.ticket({ state: "review", risk: "high" });
    expect(await submit(t3.id)).toContain("being checked and merged in the background");
    await vi.waitFor(async () => expect((await c.row(t3.id)).systemState).toBe("done"));
  });
});

describe("plan approval", () => {
  it("goes to the owner, the CEO or an agent as the policy says", async () => {
    const c = await setup();
    // Default medium: the CEO.
    const a = await c.ticket({ planFirst: true });
    await c.db.delete(wakes);
    expect(await c.plan(a.id, "p1")).toMatchObject({ tier: "ceo", forAgentId: null });
    expect((await c.db.select().from(wakes)).map((w) => w.agentId)).toEqual([c.ceo.id]);
    // Owner.
    await c.setPolicy((p) => (p.medium.planApprover = "owner"));
    expect(await c.plan(a.id, "p2")).toMatchObject({ tier: "owner", forAgentId: null });
    // An agent: the senior developer, by symbol.
    await c.setPolicy((p) => (p.medium.planApprover = "senior-dev"));
    await c.db.delete(wakes);
    expect(await c.plan(a.id, "p3")).toMatchObject({ tier: "ceo", forAgentId: c.senior.id });
    expect((await c.db.select().from(wakes)).map((w) => w.agentId)).toEqual([c.senior.id]);
    // An unavailable agent: the CEO, with a note.
    await c.db.update(agents).set({ paused: true }).where(eq(agents.id, c.senior.id));
    expect(await c.plan(a.id, "p4")).toMatchObject({ tier: "ceo", forAgentId: null });
    expect((await c.db.select().from(activity).where(eq(activity.ticketId, a.id))).map((x) => x.summary)).toContain("Sam is unavailable, so the CEO reviews it");
  });

  it("lets the agent answer its plan with the decisions tool, but not permission requests", async () => {
    const c = await setup();
    await c.setPolicy((p) => (p.medium.planApprover = c.senior.id));
    const t = await c.ticket({ planFirst: true });
    const d = await c.plan(t.id);
    const [perm] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "approval", question: "Run rm?", options: ["Allow"], recommendedOption: "Allow", tier: "ceo", forAgentId: c.senior.id, context: { type: "permission", runnerId: "x", runId: "y", requestId: "z" } })
      .returning();
    const sam = await c.mcp(c.senior.id);
    const list = textOf(await sam.callTool({ name: "decisions", arguments: { action: "list" } }));
    expect(list).toContain(PLAN);
    expect(list).not.toContain("Run rm?");
    expect(textOf(await sam.callTool({ name: "decisions", arguments: { action: "answer", id: perm!.id, answer: "Allow" } }))).toBe("No decision with that id is waiting for you.");
    expect(textOf(await sam.callTool({ name: "decisions", arguments: { action: "answer", id: d.id, answer: "Approve plan" } }))).toBe("Answered: Approve plan.");
    expect((await c.db.select().from(decisions).where(and(eq(decisions.id, d.id))))[0]!.status).toBe("answered");
    // Another worker sees nothing.
    expect(textOf(await (await c.mcp(c.other.id)).callTool({ name: "decisions", arguments: { action: "list" } }))).toBe("No decisions are waiting for you.");
  });
});

describe("review policy API", () => {
  it("serves the defaults and refuses an agent from another company", async () => {
    const c = await setup();
    expect((await c.req("GET", `/api/companies/${c.company.id}/review-policy`)).json()).toEqual(DEFAULT_REVIEW_POLICY);
    const rival = (await c.req("POST", "/api/companies", { name: "Rival Co" })).json();
    const p = structuredClone(DEFAULT_REVIEW_POLICY);
    p.low.reviewer = rival.ceo.id;
    const bad = await c.req("PUT", `/api/companies/${c.company.id}/review-policy`, p);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("isn't an active agent of this company");
    expect((await c.req("PUT", `/api/projects/${c.project.id}/review-policy`, p)).statusCode).toBe(400);
    expect((await c.req("PUT", `/api/companies/${c.company.id}/review-policy`, { low: {} })).statusCode).toBe(400);
    expect((await c.req("GET", `/api/companies/${c.company.id}/review-policy`)).json()).toEqual(DEFAULT_REVIEW_POLICY);
  });

  it("makes the risk-tier help follow the company's policy", async () => {
    const c = await setup();
    await c.setPolicy((p) => (p.low.reviewer = c.senior.id));
    const tiers = (await c.req("GET", `/api/risk-tiers?companyId=${c.company.id}`)).json() as Array<{ tier: string; summary: string }>;
    expect(tiers.find((t) => t.tier === "low")!.summary).toContain("Sam reviews it;");
    expect(tiers.find((t) => t.tier === "high")!.summary).toContain("and you sign it off");
  });
});
