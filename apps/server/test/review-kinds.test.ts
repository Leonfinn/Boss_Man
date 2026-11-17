import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy, type RunnerCommand, type RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, reviewRequests, runners, runs, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { handOverReviews } from "../src/services/review-kinds.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const DIFF = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "x", added: 1, removed: 0 }], diff: "diff --git a/x b/x", truncated: false };
const PLAN = "1. Read the limiter.";
// The branch tip the fake runner reports (BOS-1528): tests move it between two reviewers' approvals.
const branch: { head: string | null; covers: boolean } = { head: null, covers: false };
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
    if (c.type === "workspace.diff") ok({ ...DIFF, head: branch.head ?? DIFF.head });
    // BOS-1528: whether main's merges since an older head were clean (signoffCovers).
    if (c.type === "workspace.covers") ok({ covers: branch.covers, reason: "", newCommits: 0, handMerges: 0 });
    if (c.type === "workspace.verify") ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
    if (c.type === "workspace.merge") ok({ status: "merged", commit: "c".repeat(40) });
    if (c.type === "workspace.migrations") ok({ needed: false, reason: "No other branch uses this ticket's migration numbers." });
    return true;
  }, ["signoff-covers"]);
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
  return { ...built, db, req, base, company, ceo, worker, other, senior: senior!, project, ticket, row, mcp, setPolicy, plan, sent };
}


async function kinds() {
  const c = await setup();
  const [sec] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Sec", role: "worker", agentKind: "claude", title: "Security Reviewer" }).returning();
  const [infra] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Ivy", role: "worker", agentKind: "claude", title: "Infra" }).returning();
  // A legacy mark (the agent page no longer sets it): "marked" cells must keep routing as before.
  await c.db.update(agents).set({ reviewKind: "infra" }).where(eq(agents.id, infra!.id));
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
    expect(await c.call(c.infra.id, { action: "submit", verdict: "approved" })).toContain("Approved");
    await vi.waitFor(async () => expect((await c.row(c.t.id)).systemState).toBe("done"));
  });

  describe("each approval carries the head its reviewer read (BOS-1528)", () => {
    const NEW_HEAD = "d".repeat(40);
    afterEach(() => {
      branch.head = null;
      branch.covers = false;
    });

    it("stamps each reviewer's own head, and reopens an earlier reviewer when the branch moved with new code", async () => {
      const c = await kinds();
      await c.call(c.senior.id, { action: "submit", verdict: "approved" });
      await c.call(c.sec.id, { action: "submit", verdict: "approved" });
      expect((await c.rows()).filter((r) => r.status === "approved").map((r) => r.head)).toEqual([DIFF.head, DIFF.head]);
      branch.head = NEW_HEAD; // the author commits before the last reviewer answers
      expect(await c.call(c.infra.id, { action: "submit", verdict: "approved" })).toContain("reopened");
      const rows = await c.rows();
      expect(rows.find((r) => r.kind === "infra")).toMatchObject({ status: "approved", head: NEW_HEAD });
      expect(rows.filter((r) => r.kind !== "infra").map((r) => [r.status, r.head])).toEqual([["pending", null], ["pending", null]]);
      expect((await c.row(c.t.id)).systemState).toBe("review");
      expect((await c.db.select().from(activity).where(eq(activity.ticketId, c.t.id))).some((a) => a.kind === "review_reopened")).toBe(true);
    });

    it("lets the round pass when the later head only took clean merges of main", async () => {
      const c = await kinds();
      await c.call(c.senior.id, { action: "submit", verdict: "approved" });
      await c.call(c.sec.id, { action: "submit", verdict: "approved" });
      branch.head = NEW_HEAD;
      branch.covers = true;
      expect(await c.call(c.infra.id, { action: "submit", verdict: "approved" })).toContain("Approved");
      expect((await c.rows()).filter((r) => r.status === "pending")).toHaveLength(0);
      // The covered rows are restamped, so the merge sees one reviewed head and goes ahead instead of sending the ticket back.
      expect((await c.rows()).map((r) => r.head)).toEqual([NEW_HEAD, NEW_HEAD, NEW_HEAD]);
      await vi.waitFor(async () => expect((await c.row(c.t.id)).systemState).toBe("done"));
      expect(c.sent.some((m) => m.type === "workspace.merge")).toBe(true);
    });

    it("refuses to merge when one approval has no recorded head, and sends the ticket back", async () => {
      const c = await kinds();
      await c.call(c.senior.id, { action: "submit", verdict: "approved" });
      await c.call(c.sec.id, { action: "submit", verdict: "approved" });
      // This approval's head is unknown (as if the runner could not say it when it was given).
      await c.db.update(reviewRequests).set({ head: null }).where(and(eq(reviewRequests.ticketId, c.t.id), eq(reviewRequests.kind, "security")));
      expect(await c.call(c.infra.id, { action: "submit", verdict: "approved" })).toContain("Approved");
      await vi.waitFor(async () => expect((await c.row(c.t.id)).systemState).toBe("in_progress"));
      expect(c.sent.some((m) => m.type === "workspace.merge")).toBe(false);
    });

    // The merge is blocked while the rows are set up by hand; restoring the spy lets landOnce run for real.
    const approvedButNotLanded = async () => {
      const c = await kinds();
      const spy = vi.spyOn(c.review, "landOnce").mockRejectedValue(new TypeError("blocked for the test"));
      await c.call(c.senior.id, { action: "submit", verdict: "approved" });
      await c.call(c.sec.id, { action: "submit", verdict: "approved" });
      await c.call(c.infra.id, { action: "submit", verdict: "approved" });
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      spy.mockRestore();
      await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, c.t.id));
      return c;
    };

    it("sends nothing to merge when two approvals are stamped on different heads (BOS-1528 test)", async () => {
      const c = await approvedButNotLanded();
      // Set directly, bypassing the restamp that submit() does, as if a race had left two heads.
      await c.db.update(reviewRequests).set({ head: NEW_HEAD }).where(and(eq(reviewRequests.ticketId, c.t.id), eq(reviewRequests.kind, "security")));
      const before = c.sent.length;
      const r = await c.review.landOnce(c.t.id, "test");
      expect(r.outcome).toBe("branch_changed");
      expect(c.sent.slice(before).some((m) => m.type === "workspace.merge")).toBe(false);
    });

    it("still merges an old round that has no stamped heads at all (BOS-1528 test)", async () => {
      const c = await approvedButNotLanded();
      await c.db.update(reviewRequests).set({ head: null, readHead: null }).where(eq(reviewRequests.ticketId, c.t.id));
      const before = c.sent.length;
      await c.review.landOnce(c.t.id, "test");
      expect(c.sent.slice(before).some((m) => m.type === "workspace.merge")).toBe(true);
    });
  });

  describe("an approval is stamped with the head the reviewer read (BOS-1567)", () => {
    const NEW_HEAD = "d".repeat(40);
    afterEach(() => {
      branch.head = null;
      branch.covers = false;
    });

    it("refuses an approval when the branch moved after the diff, then accepts it after a fresh diff", async () => {
      const c = await kinds();
      await c.call(c.senior.id, { action: "diff" });
      expect((await c.rows()).find((r) => r.kind === "code")?.readHead).toBe(DIFF.head);
      branch.head = NEW_HEAD;
      expect(await c.call(c.senior.id, { action: "submit", verdict: "approved" })).toContain("moved since you read it");
      expect((await c.rows()).find((r) => r.kind === "code")).toMatchObject({ status: "pending", head: null, readHead: DIFF.head });
      // A retry with no fresh diff is refused again.
      expect(await c.call(c.senior.id, { action: "submit", verdict: "approved" })).toContain("moved since you read it");
      expect((await c.rows()).find((r) => r.kind === "code")?.status).toBe("pending");
      await c.call(c.senior.id, { action: "diff" });
      expect(await c.call(c.senior.id, { action: "submit", verdict: "approved" })).toContain("waiting");
      expect((await c.rows()).find((r) => r.kind === "code")).toMatchObject({ status: "approved", head: NEW_HEAD });
    });

    it("never refuses changes requested, even when the branch moved", async () => {
      const c = await kinds();
      await c.call(c.senior.id, { action: "diff" });
      branch.head = NEW_HEAD;
      await c.call(c.senior.id, { action: "submit", verdict: "changes_requested", summary: "Escape the filter." });
      expect((await c.rows()).find((r) => r.kind === "code")?.status).toBe("changes_requested");
    });

    it("stamps the current head (not the older one read) when the branch only took clean merges of main since", async () => {
      const c = await kinds();
      await c.call(c.senior.id, { action: "diff" });
      branch.head = NEW_HEAD;
      branch.covers = true;
      await c.call(c.senior.id, { action: "submit", verdict: "approved" });
      expect((await c.rows()).find((r) => r.kind === "code")).toMatchObject({ status: "approved", head: NEW_HEAD });
    });

    it("does not reopen a reviewer already approved on the newer head when a later reviewer read the older one", async () => {
      const c = await kinds();
      await c.call(c.senior.id, { action: "diff" }); // reads the old head
      branch.head = NEW_HEAD; // main merged in cleanly
      branch.covers = true;
      await c.call(c.sec.id, { action: "submit", verdict: "approved" }); // approves on the newer head
      await c.call(c.senior.id, { action: "submit", verdict: "approved" }); // read the older head
      expect(await c.call(c.infra.id, { action: "submit", verdict: "approved" })).toContain("Approved");
      const rows = await c.rows();
      expect(rows.filter((r) => r.status === "pending")).toHaveLength(0);
      expect(rows.map((r) => r.head)).toEqual([NEW_HEAD, NEW_HEAD, NEW_HEAD]);
      expect((await c.db.select().from(activity).where(eq(activity.ticketId, c.t.id))).some((a) => a.kind === "review_reopened")).toBe(false);
    });

    it("stamps the submit-time head as before when no diff was read", async () => {
      const c = await kinds();
      branch.head = NEW_HEAD;
      await c.call(c.senior.id, { action: "submit", verdict: "approved" });
      expect((await c.rows()).find((r) => r.kind === "code")).toMatchObject({ status: "approved", head: NEW_HEAD });
    });

    it("tells a reviewer reading a later page that the branch moved since the first page", async () => {
      const c = await kinds();
      await c.call(c.senior.id, { action: "diff" });
      branch.head = NEW_HEAD;
      expect(await c.call(c.senior.id, { action: "diff", offset: 10 })).toContain("The branch moved since your first page");
      expect((await c.rows()).find((r) => r.kind === "code")?.readHead).toBe(NEW_HEAD);
    });
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
    expect(await c.call(c.ceo.id, { action: "overrule", kind: "security", reason: "Out of scope for this ticket." })).toContain("Approved");
    await vi.waitFor(async () => expect((await c.row(c.t.id)).systemState).toBe("done"));
    const listed = (await c.req("GET", `/api/tickets/${c.t.id}/reviews`)).json() as Array<{ kind: string; status: string; overruleReason: string | null; reviewer: string }>;
    expect(listed.find((r) => r.kind === "security")).toMatchObject({ status: "overruled", overruleReason: "Out of scope for this ticket.", reviewer: "Sec" });
    expect((await c.db.select().from(activity).where(eq(activity.ticketId, c.t.id))).map((a) => a.summary)).toContain("The CEO overruled the security review's changes requested: Out of scope for this ticket.");
  });

  it("lets only the CEO retry a merge, and only for an approved ticket (BOS-684)", async () => {
    const c = await kinds();
    expect(await c.call(c.sec.id, { action: "retry_merge" })).toBe("Only your company's CEO can do that.");
    expect(await c.call(c.ceo.id, { action: "retry_merge" })).toContain("isn't approved yet");
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

  it("the agent page can no longer set who reviews: it points to Settings and changes nothing", async () => {
    const c = await kinds();
    const res = await c.req("PATCH", `/api/agents/${c.other.id}`, { reviewKind: "infra" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Settings > Reviews");
    const marked = (await c.db.select().from(agents).where(eq(agents.reviewKind, "infra"))).map((a) => a.id);
    expect(marked).toEqual([c.infra.id]);
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

// BOS-198: a cell may list several agents; each review still goes to exactly one of them.
describe("review cells that list several agents", () => {
  async function lists() {
    const c = await setup();
    const add = async (name: string) => (await c.db.insert(agents).values({ companyId: c.company.id, name, role: "worker", agentKind: "claude" }).returning())[0]!;
    const ann = await add("Ann");
    const bo = await add("Bo");
    const cy = await add("Cy");
    const policy = (security: string[], code: string | string[] = "senior-dev") => c.setPolicy((p) => ((p.medium.reviewer = code), (p.medium.kinds = { security })));
    const review = async (fields: Record<string, unknown> = {}) => {
      const t = await c.ticket({ state: "review", ...fields });
      await c.scheduler.onTicketReview(t.id, c.worker.id);
      return t;
    };
    const holder = async (ticketId: string, kind = "security") => (await latestRowsOf(c, ticketId)).find((r) => r.kind === kind)?.reviewerAgentId;
    const notes = async (ticketId: string) => (await c.db.select().from(activity).where(eq(activity.ticketId, ticketId))).map((a) => a.summary);
    return { ...c, ann, bo, cy, policy, review, holder, notes };
  }
  const latestRowsOf = async (c: { db: Awaited<ReturnType<typeof setup>>["db"] }, ticketId: string) => {
    const all = await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, ticketId));
    const top = Math.max(...all.map((r) => r.round));
    return all.filter((r) => r.round === top);
  };

  it("saves a list and refuses a duplicate, an empty list or a CEO mixed into it", async () => {
    const c = await lists();
    expect((await c.policy([c.ann.id, c.bo.id])).statusCode).toBe(200);
    expect((await c.req("GET", `/api/companies/${c.company.id}/review-policy`)).json().medium.kinds.security).toEqual([c.ann.id, c.bo.id]);
    expect((await c.policy([c.ann.id, c.ann.id])).statusCode).toBe(400);
    expect((await c.policy([])).statusCode).toBe(400);
    expect((await c.policy([c.ann.id, "ceo"])).statusCode).toBe(400);
  });

  it("gives one review per kind to the least loaded listed agent, list order breaking a first tie", async () => {
    const c = await lists();
    await c.policy([c.ann.id, c.bo.id]);
    const t1 = await c.review();
    expect((await latestRowsOf(c, t1.id)).map((r) => r.kind).sort()).toEqual(["code", "security"]);
    expect(await c.holder(t1.id)).toBe(c.ann.id);
    // Ann now holds an open review, Bo none.
    const t2 = await c.review();
    expect(await c.holder(t2.id)).toBe(c.bo.id);
  });

  it("breaks a tie on load by who was given a review least recently", async () => {
    const c = await lists();
    await c.policy([c.ann.id, c.bo.id]);
    const t1 = await c.review();
    const t2 = await c.review();
    expect([await c.holder(t1.id), await c.holder(t2.id)]).toEqual([c.ann.id, c.bo.id]);
    // Both finish: equal load (0); Ann was given hers first, so she is next.
    await c.db.update(reviewRequests).set({ status: "approved" }).where(eq(reviewRequests.kind, "security"));
    const t3 = await c.review();
    expect(await c.holder(t3.id)).toBe(c.ann.id);
  });

  it("never picks the author, anyone who worked on the ticket, or a paused or retired agent", async () => {
    const c = await lists();
    await c.policy([c.ann.id, c.bo.id, c.cy.id]);
    await c.db.update(agents).set({ paused: true }).where(eq(agents.id, c.ann.id));
    await c.db.update(agents).set({ retiredAt: new Date() }).where(eq(agents.id, c.bo.id));
    expect(await c.holder((await c.review()).id)).toBe(c.cy.id);
    // Cy wrote this one, so with Ann paused and Bo retired nobody listed can take it.
    const mine = await c.review({ assigneeAgentId: c.cy.id });
    expect(await c.holder(mine.id)).toBe(c.ceo.id);
    expect(await c.notes(mine.id)).toContain("No listed security reviewer can take it (Ann is paused; Bo is retired; Cy worked on it), so CEO reviews it");
    // A run on the ticket that isn't a review counts as working on it.
    await c.db.update(agents).set({ paused: false }).where(eq(agents.id, c.ann.id));
    const t = await c.ticket({ state: "review" });
    await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.ann.id, ticketId: t.id });
    await c.scheduler.onTicketReview(t.id, c.worker.id);
    expect(await c.holder(t.id)).toBe(c.cy.id);
  });

  it("keeps the same reviewer across rounds while they can, and moves on when they can't", async () => {
    const c = await lists();
    await c.policy([c.ann.id, c.bo.id]);
    const t = await c.review();
    expect(await c.holder(t.id)).toBe(c.ann.id);
    // Ann gets busier than Bo elsewhere, yet round 2 stays with her for the context.
    await c.review();
    await c.review();
    await c.scheduler.onTicketReview(t.id, c.worker.id);
    expect((await latestRowsOf(c, t.id))[0]!.round).toBe(2);
    expect(await c.holder(t.id)).toBe(c.ann.id);
    await c.db.update(agents).set({ paused: true }).where(eq(agents.id, c.ann.id));
    await c.scheduler.onTicketReview(t.id, c.worker.id);
    expect(await c.holder(t.id)).toBe(c.bo.id);
  });

  it("lists work for the code review too, and the reviewer it picked can review", async () => {
    const c = await lists();
    await c.policy([c.cy.id], [c.ann.id, c.bo.id]);
    const t = await c.review();
    expect(await c.holder(t.id, "code")).toBe(c.ann.id);
    const res = await (await c.mcp(c.ann.id)).callTool({ name: "review", arguments: { ticketId: t.id, action: "submit", verdict: "approved", kind: "code" } });
    expect(textOf(res)).not.toContain("Only your company's CEO");
  });

  it("hands a busy listed reviewer's review to a free listed colleague", async () => {
    const c = await lists();
    await c.policy([c.ann.id, c.bo.id]);
    const t = await c.review();
    const [w] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.ann.id));
    const left = await handOverReviews(c.db, { agentId: c.ann.id, note: w!.note }, () => false, async () => undefined, 11 * 60_000);
    expect(await c.holder(t.id)).toBe(c.bo.id);
    expect(left).toBeNull();
  });

  it("shows the CEO each agent's reviews on the board, from the same settings", async () => {
    const c = await lists();
    await c.policy([c.ann.id, c.bo.id], [c.ann.id]);
    // The board tool is the CEO's chat view of the team.
    const [run] = await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.ceo.id, purpose: "chat" }).returning();
    const token = await issueRunToken(c.db, { companyId: c.company.id, agentId: c.ceo.id, runId: run!.id });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://${c.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const board = JSON.parse(textOf(await client.callTool({ name: "board", arguments: {} }))) as { agents: Array<{ name: string; reviews?: string }> };
    const of = (name: string) => board.agents.find((a) => a.name === name)!.reviews;
    expect(of("Ann")).toBe("Code (Medium), Security (Medium)");
    expect(of("Bo")).toBe("Security (Medium)");
    expect(of("Sam")).toBe("Code (High+)");
    expect(of("Cy")).toBeUndefined();
    await client.close();
  });

  it("names everyone listed in the risk help", async () => {
    const c = await lists();
    await c.policy([c.cy.id], [c.ann.id, c.bo.id]);
    const tiers = (await c.req("GET", `/api/risk-tiers?companyId=${c.company.id}`)).json() as Array<{ tier: string; summary: string }>;
    expect(tiers.find((x) => x.tier === "medium")!.summary).toContain("Ann or Bo");
  });
});
