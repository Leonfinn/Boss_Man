// BOS-503: a ticket owed the owner's sign-off always has exactly one open card, and nothing merges it without one.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, reviewRequests, runners, runs, ticketDependencies, ticketReviews, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const DIFF = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "x", added: 1, removed: 0 }], diff: "diff --git a/x b/x", truncated: false };
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

async function setup(o: { covers?: { covers: boolean; reason: string; newCommits: number; handMerges: number } } = {}) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  ctx = { close: async () => (await Promise.all(clients.map((c) => c.close())), await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const [senior] = await db.insert(agents).values({ companyId: company.id, name: "Sam", role: "worker", agentKind: "claude", title: "Senior Developer", template: "senior-dev" }).returning();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") ok(DIFF);
    if (c.type === "workspace.verify") ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
    if (c.type === "workspace.merge") ok({ status: "merged", commit: "c".repeat(40) });
    if (c.type === "workspace.carried") ok({ carried: [] });
    if (c.type === "workspace.migrations") ok({ needed: false, reason: "free" });
    if (c.type === "workspace.covers" && o.covers) ok(o.covers);
    return true;
  }, o.covers ? ["carried-check", "signoff-covers"] : ["carried-check"]);
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const mcp = async (agentId: string) => {
    const runId = randomUUID();
    await db.insert(runs).values({ id: runId, companyId: company.id, agentId });
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  /** A high-risk ticket in review whose one review passed hours ago: owed the owner's sign-off. */
  const approvedHighRisk = async () => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Fix the deployer", assigneeAgentId: worker.id, risk: "high" })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, systemState: "review" }).where(eq(tickets.id, t.id));
    await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: senior!.id, round: 1, seq: 0, status: "approved", decidedAt: new Date(Date.now() - 4 * 3_600_000) });
    return t;
  };
  const cards = (ticketId: string, status?: "open" | "answered" | "withdrawn") =>
    db.select().from(decisions).where(and(sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${ticketId}`, ...(status ? [eq(decisions.status, status)] : [])));
  const merges = () => sent.filter((x) => x.type === "workspace.merge").length;
  /** The ticket as the board shows it. */
  const boardCard = async (ticketId: string) => {
    const found: Array<Record<string, unknown>> = [];
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") {
        if ((x as { id?: unknown }).id === ticketId && "waitingOnOwner" in x) found.push(x as Record<string, unknown>);
        Object.values(x).forEach(walk);
      }
    };
    walk((await req("GET", `/api/projects/${project.id}/board`)).json());
    return found[0]!;
  };
  /** An owner sign-off on the card, recorded for a commit (DR-013), as the Decisions answer writes it. */
  const signedOffCard = (ticketId: string, head: string) =>
    db.insert(decisions).values({ companyId: company.id, kind: "approval", question: "Merge it?", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", status: "answered", answer: "Approve and merge", answeredAt: new Date(Date.now() - 3_600_000), context: { type: "risk_review", ticketId, reviewer: "Sam", head, risk: "high", signedOff: { head, risk: "high", at: new Date(Date.now() - 3_600_000).toISOString(), by: "owner" } } });
  return { ...built, db, req, company, ceo, senior: senior!, worker, row, mcp, approvedHighRisk, cards, merges, boardCard, signedOffCard };
}

describe("owner sign-off cards (BOS-503)", () => {
  it("puts a lost card back once, tells the CEO once, and never merges the ticket meanwhile", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    // The card the owner never saw: raised, then gone (withdrawn, its hold dropped).
    const [lost] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "old", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", status: "withdrawn", context: { type: "risk_review", ticketId: t.id, reviewer: "Sam" } }).returning();
    expect((await c.req("GET", `/api/tickets/${t.id}`)).json().signoff).toBe("missing");
    await c.db.delete(wakes);

    expect(await c.sweeps.run()).toMatchObject({ signoffCards: 1, unmergedApprovals: 0 });
    const open = await c.cards(t.id, "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ tier: "owner", options: ["Approve and merge", "Send it back"], raisedByAgentId: c.senior.id });
    expect(open[0]!.id).not.toBe(lost!.id);
    // It holds the ticket, so it is in the owner's queue and the board's Your review lane.
    expect(await c.db.select().from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, t.id), eq(ticketDependencies.blockerDecisionId, open[0]!.id)))).toHaveLength(1);
    expect(((await c.req("GET", "/api/decisions")).json() as Array<{ id: string }>).map((d) => d.id)).toContain(open[0]!.id);
    const ceoWakes = await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id));
    expect(ceoWakes).toHaveLength(1);
    expect(ceoWakes[0]!.note).toContain(open[0]!.id);

    // The next sweeps add nothing: one card per ticket, one word to the CEO, and still no merge.
    expect(await c.sweeps.run()).toMatchObject({ signoffCards: 0, unmergedApprovals: 0 });
    expect(await c.cards(t.id, "open")).toHaveLength(1);
    expect(await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).toHaveLength(1);
    expect(c.merges()).toBe(0);

    // The page and the tools say where it stands.
    expect((await c.req("GET", `/api/tickets/${t.id}`)).json()).toMatchObject({ signoff: "waiting", signoffWaiting: true });
    expect(textOf(await (await c.mcp(c.worker.id)).callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id } }))).toMatch(new RegExp(`Owner sign-off: waiting on the owner since .* \\(card ${open[0]!.id}`));
  });

  it("refuses a merge retry for a ticket whose card is missing, and raises the card instead", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    await expect(c.review.land(t.id, "Boss Man")).rejects.toThrow(/sign-off/);
    expect(await c.cards(t.id, "open")).toHaveLength(1);
    expect(c.merges()).toBe(0);
    expect((await c.row(t.id)).systemState).toBe("review");
  });

  it("answering the card in Decisions settles the one card and merges once", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    await c.sweeps.run();
    const [card] = await c.cards(t.id, "open");
    expect((await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Approve and merge" })).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    expect(c.merges()).toBe(1);
    expect(await c.cards(t.id)).toHaveLength(1);
    expect(await c.cards(t.id, "answered")).toHaveLength(1);
  });

  it("Approve and merge on the ticket page settles the same card and merges once", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    await c.sweeps.run();
    const r = await c.req("POST", `/api/tickets/${t.id}/approve-merge`);
    expect(r.json()).toMatchObject({ signoffAnswered: true });
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    expect(c.merges()).toBe(1);
    expect(await c.cards(t.id)).toHaveLength(1);
    expect(await c.cards(t.id, "answered")).toHaveLength(1);
  });

  it("Approve and merge on the page before the sweep runs is the sign-off itself: it merges, and no card follows", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    await c.req("POST", `/api/tickets/${t.id}/approve-merge`);
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    expect(c.merges()).toBe(1);
    expect(await c.sweeps.run()).toMatchObject({ signoffCards: 0 });
    expect(await c.cards(t.id)).toHaveLength(0);
  });

  it("raises the card itself when an agent's reply asks the owner to review and none covers it", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    const out = textOf(await (await c.mcp(c.worker.id)).callTool({ name: "ticket_reply", arguments: { ticketId: t.id, text: "All reviews passed. Please review and approve it, or send it back." } }));
    const open = await c.cards(t.id, "open");
    expect(open).toHaveLength(1);
    expect(out).toContain(`Boss Man raised it (card ${open[0]!.id})`);
    // A second ask finds the card and adds nothing.
    const again = textOf(await (await c.mcp(c.worker.id)).callTool({ name: "ticket_reply", arguments: { ticketId: t.id, text: "Please review it." } }));
    expect(again).not.toContain("raise_decision");
    expect(await c.cards(t.id, "open")).toHaveLength(1);
  });

  it("shows a ticket waiting on sign-off in Your review even with no card (DR-021)", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    expect(await c.cards(t.id)).toHaveLength(0);
    expect(await c.boardCard(t.id)).toMatchObject({ waitingOnOwner: true, approvedBy: "Sam", noReviewer: false });
  });

  it("refuses a merge whose recorded sign-off is for another commit, in plain sight (DR-013, DR-021)", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    // Signed off an hour ago for commit d…; the runner says b… would merge now.
    await c.signedOffCard(t.id, "d".repeat(40));
    await expect(c.review.land(t.id, "Boss Man")).rejects.toThrow(/signed off commit dddddddd, but the branch is now at bbbbbbbb/);
    expect(c.merges()).toBe(0);
    expect((await c.row(t.id)).systemState).toBe("review");
    // In plain sight: the merge card says why and lets the owner send it back; no sign-off card for unreviewed code.
    const stuck = await c.db.select().from(decisions).where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'check_stuck'`));
    expect(stuck).toHaveLength(1);
    expect(await c.cards(t.id, "open")).toHaveLength(0);
  });

  it("merges when the recorded sign-off covers the commit being merged, with no card raised", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    await c.signedOffCard(t.id, "b".repeat(40));
    await c.review.land(t.id, "Boss Man");
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    expect(c.merges()).toBe(1);
    expect(await c.cards(t.id, "open")).toHaveLength(0);
  });

  it("the sweep never retries a merge for a ticket waiting on sign-off, card or not", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    await c.sweeps.run();
    // Card open, merge window long past: still not retried.
    expect(await c.sweeps.run()).toMatchObject({ unmergedApprovals: 0, signoffCards: 0 });
    expect(c.merges()).toBe(0);
    expect((await c.row(t.id)).systemState).toBe("review");
  });

  it("the card closes itself when a new review round starts, and no second card is raised meanwhile", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    await c.sweeps.run();
    const [card] = await c.cards(t.id, "open");
    await c.db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: c.senior.id, round: 2, seq: 0, status: "pending" });
    await c.sweeps.run();
    expect(await c.cards(t.id, "open")).toHaveLength(0);
    const [gone] = await c.db.select().from(decisions).where(eq(decisions.id, card!.id));
    expect(gone).toMatchObject({ status: "withdrawn" });
    expect((gone!.context as { withdrawn?: { note?: string } }).withdrawn?.note).toContain("new review round");
    // Its hold went with it.
    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, card!.id))).toHaveLength(0);
  });

  it("the card closes itself when the ticket leaves review (cancelled or merged elsewhere)", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    await c.sweeps.run();
    await c.db.update(tickets).set({ systemState: "done", outcome: "cancelled" }).where(eq(tickets.id, t.id));
    await c.sweeps.run();
    expect(await c.cards(t.id, "open")).toHaveLength(0);
    expect(await c.cards(t.id, "withdrawn")).toHaveLength(1);
  });

  it("raising the card twice still leaves one open card", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    const { restoreSignoffCard } = await import("../src/services/signoff.js");
    const row = await c.row(t.id);
    const [a, b] = await Promise.all([restoreSignoffCard(c.db, row, "test"), restoreSignoffCard(c.db, row, "test")]);
    expect(a ?? b).toBeTruthy();
    await c.sweeps.run();
    expect(await c.cards(t.id, "open")).toHaveLength(1);
  });

  it("the owner's own approval from an earlier round doesn't sign off the next round (Freddy, round 1)", async () => {
    const c = await setup();
    const t = await c.approvedHighRisk();
    const { derivedSignoff } = await import("../src/services/signoff.js");
    // Round 1 (requested 5 h ago): the owner approved on the page (no card), then the merge failed and the work went back.
    await c.db.update(reviewRequests).set({ createdAt: new Date(Date.now() - 5 * 3_600_000) }).where(eq(reviewRequests.ticketId, t.id));
    await c.db.insert(ticketReviews).values({ ticketId: t.id, reviewer: "the owner", verdict: "approved", createdAt: new Date(Date.now() - 3 * 3_600_000) });
    expect((await derivedSignoff(c.db, await c.row(t.id))).state).toBe("signed_off");
    // Round 2 starts: the old approval no longer counts, and nothing merges it.
    await c.db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: c.senior.id, round: 2, seq: 0, status: "pending", createdAt: new Date(Date.now() - 3_600_000) });
    expect((await derivedSignoff(c.db, await c.row(t.id))).state).toBe("reviews_pending");
    await expect(c.review.land(t.id, "Boss Man")).rejects.toThrow(/sign-off/);
    // Round 2 passes: it waits on the owner again, with one card, and still isn't merged.
    await c.db.update(reviewRequests).set({ status: "approved", decidedAt: new Date(Date.now() - 1_800_000) }).where(and(eq(reviewRequests.ticketId, t.id), eq(reviewRequests.round, 2)));
    expect((await derivedSignoff(c.db, await c.row(t.id))).state).toBe("waiting");
    expect(await c.sweeps.run()).toMatchObject({ signoffCards: 1, unmergedApprovals: 0 });
    expect(c.merges()).toBe(0);
  });

  it("a medium-risk ticket (no sign-off) is not touched", async () => {
    const c = await setup();
    const mid = await c.approvedHighRisk();
    await c.db.update(tickets).set({ risk: "medium" }).where(eq(tickets.id, mid.id));
    expect((await c.req("GET", `/api/tickets/${mid.id}`)).json().signoff).toBeNull();
    expect(await c.sweeps.run()).toMatchObject({ signoffCards: 0 });
    await vi.waitFor(async () => expect((await c.row(mid.id)).systemState).toBe("done"));
  });
});

// BOS-734 / DR-038: a card for older code is never left for the owner to press, and a sign-off carries over only a clean main merge.
describe("a sign-off and the branch moving on (BOS-734)", () => {
  const COVERS = { covers: true, reason: "main only", newCommits: 0, handMerges: 0 };
  const NOT = { covers: false, reason: "1 new commit of the ticket's own since the sign-off", newCommits: 1, handMerges: 0 };
  const openCard = (c: Awaited<ReturnType<typeof setup>>, ticketId: string, head: string) =>
    c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Merge it, or send it back?", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", status: "open", context: { type: "risk_review", ticketId, reviewer: "Sam", head, risk: "high" } }).returning();

  it("merges on a sign-off for an earlier commit when only clean main merges came in", async () => {
    const c = await setup({ covers: COVERS });
    const t = await c.approvedHighRisk();
    await c.signedOffCard(t.id, "d".repeat(40));
    await c.review.land(t.id, "Boss Man");
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    expect(c.merges()).toBe(1);
  });

  it("still refuses when the runner says the changes aren't just clean main merges", async () => {
    const c = await setup({ covers: NOT });
    const t = await c.approvedHighRisk();
    await c.signedOffCard(t.id, "d".repeat(40));
    await expect(c.review.land(t.id, "Boss Man")).rejects.toThrow(/signed off commit dddddddd/);
    expect(c.merges()).toBe(0);
  });

  it("pressing a card for older code is refused with the reason, the card is withdrawn and the ticket goes back for review, with no new card", async () => {
    const c = await setup({ covers: NOT });
    const t = await c.approvedHighRisk();
    const [card] = await openCard(c, t.id, "d".repeat(40));
    const res = await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Approve and merge" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toMatch(/changed after this card was raised/);
    expect(c.merges()).toBe(0);
    // Unreviewed code never gets a fresh "Approve and merge" card: the reviewers must pass it first.
    expect(await c.cards(t.id, "open")).toHaveLength(0);
    expect((await c.row(t.id)).systemState).toBe("in_progress");
    expect(c.merges()).toBe(0);
  });

  it("the sweep moves a card to the new head when only clean main merges came in, and replaces it otherwise", async () => {
    const same = await setup({ covers: COVERS });
    const t1 = await same.approvedHighRisk();
    const [card] = await openCard(same, t1.id, "d".repeat(40));
    await same.sweeps.run();
    const [kept] = await same.cards(t1.id, "open");
    expect(kept!.id).toBe(card!.id);
    expect((kept!.context as { head?: string }).head).toBe("b".repeat(40));
    await ctx?.close();
    ctx = undefined;

    const diff = await setup({ covers: NOT });
    const t2 = await diff.approvedHighRisk();
    const [old] = await openCard(diff, t2.id, "d".repeat(40));
    await diff.sweeps.run();
    expect(await diff.cards(t2.id, "open")).toHaveLength(0);
    expect((await diff.cards(t2.id, "withdrawn")).map((x) => x.id)).toContain(old!.id);
    expect((await diff.row(t2.id)).systemState).toBe("in_progress");
  });
});
