// BOS-1094: the owner's "Send it back" on an agent's card stops the ticket's merge (BOS-1071 merged after it), and a
// diff that touches scripts/check-all.sh never merges without the owner's sign-off, even with no card raised.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ownerApprovedFiles, type RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, reviewRequests, tickets } from "../src/db/schema.js";
import { isRefusalAnswer } from "../src/services/decisions.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const diffOf = (path: string) => ({ baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path, added: 1, removed: 0 }], diff: "", truncated: false });

async function setup(path = "apps/server/src/x.ts", diffFails = false) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const [senior] = await db.insert(agents).values({ companyId: company.id, name: "Sam", role: "worker", agentKind: "claude", title: "Senior Developer", template: "senior-dev" }).returning();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const sent: RunnerCommand[] = [];
  built.runners.connect(
    reg.runnerId,
    (c) => {
      sent.push(c);
      const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
      if (c.type === "workspace.diff" && diffFails) queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: false, error: "timed out" }));
      else if (c.type === "workspace.diff") ok(diffOf(path));
      if (c.type === "workspace.verify") ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
      if (c.type === "workspace.merge") ok({ status: "merged", commit: "c".repeat(40) });
      if (c.type === "workspace.carried") ok({ carried: [] });
      if (c.type === "workspace.migrations") ok({ needed: false, reason: "free" });
      return true;
    },
    ["carried-check"],
  );
  /** A medium-risk ticket in review whose one review passed. */
  const approved = async (risk = "medium") => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Change the check", assigneeAgentId: worker.id, risk })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, systemState: "review" }).where(eq(tickets.id, t.id));
    await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: senior!.id, round: 1, seq: 0, status: "approved", decidedAt: new Date(Date.now() - 3_600_000) });
    return t;
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const merges = () => sent.filter((x) => x.type === "workspace.merge").length;
  const question = (ticketId: string) =>
    built.decisions.raise({ companyId: company.id, agentId: worker.id, question: "OK to approve the check-all.sh change?", options: ["Approve", "Send it back"], recommended: "Approve", blocksTicketId: ticketId, triedFirst: "Read CLAUDE.md; only the owner approves this." });
  const queue = () => req("GET", `/api/companies/${company.id}/merge-queue`).then((r) => r.json());
  return { ...built, db, company, row, approved, merges, question, queue };
}

describe("isRefusalAnswer", () => {
  it("counts only a refusal button of the card", () => {
    const opts = ["Approve", "Send it back", "Deny", "Reject", "No"];
    for (const a of ["Send it back", "Deny", "Reject"]) expect(isRefusalAnswer(a, opts)).toBe(true);
    expect(isRefusalAnswer("Approve", opts)).toBe(false);
    expect(isRefusalAnswer("No", opts)).toBe(false);
    expect(isRefusalAnswer("Send it back", ["Approve", "Wait"])).toBe(false); // free text, not a button
  });
});

describe("ownerApprovedFiles", () => {
  it("names check-all.sh only", () => {
    expect(ownerApprovedFiles(["a.ts", "scripts/check-all.sh"])).toEqual(["scripts/check-all.sh"]);
    expect(ownerApprovedFiles(["scripts/check-quick.sh"])).toEqual([]);
  });
});

describe("an owner's refusal on a card about a ticket in review (BOS-1094)", () => {
  it('"Send it back" puts the ticket back in progress and nothing merges', async () => {
    const c = await setup();
    const t = await c.approved();
    const card = await c.question(t.id);
    await c.decisions.answer(card.id, "Send it back");
    expect((await c.row(t.id)).systemState).toBe("in_progress");
    expect(c.merges()).toBe(0);
  });

  it('"Approve" leaves the ticket in review and it merges', async () => {
    const c = await setup();
    const t = await c.approved();
    const card = await c.question(t.id);
    await c.decisions.answer(card.id, "Approve");
    expect((await c.row(t.id)).systemState).toBe("review");
    await c.review.landOnce(t.id, "Boss Man");
    expect(c.merges()).toBe(1);
  });
});

describe("a diff that touches scripts/check-all.sh (BOS-1094)", () => {
  it("is held for the owner's sign-off with no card raised, with the reason on the card and the queue", async () => {
    const c = await setup("scripts/check-all.sh");
    const t = await c.approved();
    await expect(c.review.landOnce(t.id, "Boss Man")).rejects.toThrow(/sign-off|owner/i);
    expect(c.merges()).toBe(0);
    expect((await c.row(t.id)).risk).toBe("high");
    const [card] = await c.db.select().from(decisions).where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${t.id}`));
    expect(card!.question).toContain("scripts/check-all.sh");
    const view = (await c.queue()) as { waiting: Array<{ ticketId: string; state: string; card?: { question: string } }> };
    expect(view.waiting.find((w) => w.ticketId === t.id)).toMatchObject({ state: "waiting_for_sign_off" });
    // The owner's approval starts the merge; wait for the runner to see it (a deadline, not a fixed sleep).
    await c.decisions.answer(card!.id, "Approve and merge");
    const deadline = Date.now() + 20_000;
    while (c.merges() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(c.merges()).toBe(1);
  });

  it("does not merge when the changed files can't be read (fails closed)", async () => {
    const c = await setup("scripts/check-all.sh", true);
    const t = await c.approved();
    await c.review.landOnce(t.id, "Boss Man").catch(() => undefined);
    expect(c.merges()).toBe(0);
  });

  it("an ordinary diff is not held", async () => {
    const c = await setup();
    const t = await c.approved();
    await c.review.landOnce(t.id, "Boss Man");
    expect(c.merges()).toBe(1);
    expect((await c.row(t.id)).risk).toBe("medium");
  });
});
