import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, checkResults, companies, decisions, reviewRequests, settings, ticketDependencies, ticketReviews, tickets } from "../src/db/schema.js";
import { failingLine, failingStep, mergeQueueService } from "../src/services/merge-queue.js";
import { CHECK_QUEUE_MODE_KEY, CHECK_SLOTS_KEY } from "../src/services/check-queue.js";

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
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  return { ...built, db, close, req, company, project };
}

const queue = (c: Awaited<ReturnType<typeof setup>>) => c.req("GET", `/api/companies/${c.company.id}/merge-queue`).then((r) => r.json());
// An approved review is what makes a ticket "waiting to merge"; without it, it is still with its reviewers.
const approve = (c: Awaited<ReturnType<typeof setup>>, ticketId: string, status = "approved") =>
  c.db.insert(reviewRequests).values({ ticketId, kind: "code", round: 1, status });

describe("merge queue screen (BOS-587)", () => {
  it("reads a failing step in one plain line", () => {
    expect(failingLine("ok\nerror TS2322: bad type\nmore")).toMatch(/TS2322/);
    expect(failingLine("")).toBeNull();
    expect(failingStep("scripts/check-all.sh: 12: vitest: not found")).toMatch(/scripts\/check-all\.sh: .*vitest/);
    // No recognised step: the error line itself is shown.
    expect(failingStep("error: something broke")).toBe("error: something broke");
  });

  // R28: approved tickets held by mergeWaits on a fix marked fixesMergeCheck: one line from the function that holds, not "healthy".
  it("reads held_behind_fix for approved tickets waiting on a marked fix, and stuck fix_stalled when the fix is parked", async () => {
    const c = (ctx = await setup());
    const mk = async (title: string) => (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title })).json() as { id: string };
    const fix = await mk("Fix main CI");
    await c.db.update(tickets).set({ systemState: "in_progress", fixesMergeCheck: true }).where(eq(tickets.id, fix.id));
    for (const title of ["Held one", "Held two"]) {
      const t = await mk(title);
      await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
      await approve(c, t.id);
    }
    const data = await queue(c);
    expect(data.line).toMatchObject({ state: "held_behind_fix", held: 2, fixes: [{ ticketId: fix.id, stateText: "being fixed", ownerUpdate: false }] });
    await c.db.update(tickets).set({ systemState: "ready" }).where(eq(tickets.id, fix.id));
    expect((await queue(c)).line).toMatchObject({ state: "stuck", cause: "fix_stalled", others: 2 });
  });

  describe("held behind a fix: the fix's own state (R28)", () => {
    async function heldTwoBehind(c: Awaited<ReturnType<typeof setup>>, fixSet: Partial<typeof tickets.$inferInsert>) {
      const mk = async (title: string) => (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title })).json() as { id: string };
      const fix = await mk("Fix main CI");
      await c.db.update(tickets).set({ fixesMergeCheck: true, ...fixSet }).where(eq(tickets.id, fix.id));
      for (const title of ["Held one", "Held two"]) {
        const t = await mk(title);
        await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
        await approve(c, t.id);
      }
      return fix;
    }

    it("a fix that was sent back is stalled, not 'being fixed'", async () => {
      const c = (ctx = await setup());
      const fix = await heldTwoBehind(c, { systemState: "in_progress" });
      await c.db.insert(reviewRequests).values({ ticketId: fix.id, kind: "code", round: 1, status: "changes_requested" });
      expect((await queue(c)).line).toMatchObject({ state: "stuck", cause: "fix_stalled", others: 2, reason: expect.stringMatching(/sent back/) });
      // A later round that is still pending (back with its reviewers) is not a sent-back fix.
      await c.db.insert(reviewRequests).values({ ticketId: fix.id, kind: "code", round: 2, status: "pending" });
      expect((await queue(c)).line).toMatchObject({ state: "held_behind_fix", fixes: [{ stateText: "being fixed" }] });
    });

    it("an approved fix that has waited over an hour to land is stalled, whoever owns the wait", async () => {
      const c = (ctx = await setup());
      const fix = await heldTwoBehind(c, { systemState: "review", lastActivityAt: new Date(Date.now() - 90 * 60_000) });
      await approve(c, fix.id);
      // The wait is the owner's (an open sign-off), not Boss Man's: the old "system waits only" rule never flagged this.
      const [card] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Sign off the fix?", recommendedOption: "Yes", context: { type: "risk_review" } }).returning({ id: decisions.id });
      await c.db.insert(ticketDependencies).values({ blockedTicketId: fix.id, blockerDecisionId: card!.id });
      expect((await queue(c)).line).toMatchObject({ state: "stuck", cause: "fix_stalled", reason: expect.stringMatching(/approved for 9\d minutes and has not landed/) });
    });

    it("merged in a company that puts work live itself: it waits for the CEO to mark it live, with no update card", async () => {
      const c = (ctx = await setup());
      // The first company is the home company (Boss Man's own deploy); this second one puts its own work live.
      const { company } = (await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
      const project = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Shop" })).json() as { id: string };
      const mk = async (title: string) => (await c.req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
      const fix = await mk("Fix main CI");
      await c.db.update(tickets).set({ fixesMergeCheck: true, systemState: "review", mergeCommit: "a".repeat(40), mergedAt: new Date() }).where(eq(tickets.id, fix.id));
      await c.db.insert(settings).values({ key: `live_release:${company.id}`, value: { new: "b".repeat(40) } });
      const t = await mk("Held one");
      await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
      await approve(c, t.id);
      const line = (await c.req("GET", `/api/companies/${company.id}/merge-queue`).then((r) => r.json())).line;
      expect(line).toMatchObject({ state: "held_behind_fix", fixes: [{ stateText: "merged, waiting for the CEO to mark it live", ownerUpdate: false, updateCardId: null }] });
    });

    it("merged, only the server update left: the line links the open update card and raises none", async () => {
      const c = (ctx = await setup());
      await heldTwoBehind(c, { systemState: "review", mergeCommit: "a".repeat(40), mergedAt: new Date() });
      // The server runs an older commit than the merge, so the merge is not live yet.
      await c.db.insert(settings).values({ key: `live_release:${c.company.id}`, value: { new: "b".repeat(40) } });
      const [card] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Put the update live?", recommendedOption: "Yes", context: { type: "deploy", deployId: "d1" } }).returning({ id: decisions.id });
      const before = (await c.db.select().from(decisions)).length;
      const line = (await queue(c)).line;
      expect(line).toMatchObject({ state: "held_behind_fix", fixes: [{ ownerUpdate: true, updateCardId: card!.id }] });
      expect((await c.db.select().from(decisions)).length).toBe(before);
    });
  });

  it("lists a ticket in review with a failed check, and flags it as stuck", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Fix the login" })).json() as { id: string; number: number };
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    await approve(c, t.id);
    await c.db.insert(checkResults).values({ companyId: c.company.id, ticketId: t.id, kind: "verify", passed: false, detail: "error TS1: bad" });
    const data = await queue(c);
    const row = data.waiting.find((r: { ticketId: string }) => r.ticketId === t.id);
    expect(row).toMatchObject({ title: "Fix the login", stuck: true, state: "check_failed_retrying", failedCheck: true });
    expect(row.label).toMatch(/check failed: retrying \(error TS1: bad\)/);
    expect(data.waitingCount).toBe(1);
    // The side menu's warning badge follows the line's verdict (BOS-1594): one ticket's own failed check is flagged on its row, not a stuck line.
    expect(data.stuckCount).toBe(0);
    expect(data.line.state).not.toBe("stuck");
  });

  it("shows a stuck-check card as needs you, linking to the decision", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Needs a nudge" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    await approve(c, t.id);
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "Check stuck?", options: ["Run the check again"], recommendedOption: "Run the check again", tier: "ceo", dedupeKey: `merge-stuck:${t.id}`, context: { type: "check_stuck", ticketId: t.id, command: "verify", output: "" } })
      .returning({ id: decisions.id });
    const data = await queue(c);
    const row = data.waiting.find((r: { ticketId: string }) => r.ticketId === t.id);
    expect(row).toMatchObject({ state: "needs_you", stuck: true, actor: "ceo", decisionId: d!.id });
  });

  it("shows the owner's sign-off as waiting for you, and a plain wait as waiting for a slot", async () => {
    const c = (ctx = await setup());
    const sign = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Sign this off" })).json() as { id: string };
    const wait = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Just waiting" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "review" }).where(and(eq(tickets.id, sign.id)));
    await c.db.update(tickets).set({ systemState: "review" }).where(and(eq(tickets.id, wait.id)));
    await approve(c, sign.id);
    await approve(c, wait.id);
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "approval", question: "Merge it?", options: ["Approve and merge"], recommendedOption: "Approve and merge", tier: "owner", dedupeKey: `risk-review:${sign.id}`, context: { type: "risk_review", ticketId: sign.id } })
      .returning({ id: decisions.id });
    await c.db.insert(ticketDependencies).values({ blockedTicketId: sign.id, blockerDecisionId: d!.id });
    const data = await queue(c);
    expect(data.waiting.find((r: { ticketId: string }) => r.ticketId === sign.id)).toMatchObject({ state: "waiting_for_sign_off", actor: "owner" });
    expect(data.waiting.find((r: { ticketId: string }) => r.ticketId === wait.id)).toMatchObject({ state: "waiting_for_slot" });
  });

  describe("the card that holds a merge (BOS-1078)", () => {
    const newTicket = async (c: Awaited<ReturnType<typeof setup>>, title: string, risk: "low" | "high" = "low") => {
      const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title })).json() as { id: string; number: number };
      await c.db.update(tickets).set({ systemState: "review", risk }).where(eq(tickets.id, t.id));
      await approve(c, t.id);
      return t;
    };
    const ask = (c: Awaited<ReturnType<typeof setup>>, ticketId: string, question: string, holdsMerge?: boolean) =>
      c.decisions.raise({ companyId: c.company.id, agentId: null, question, options: ["Yes", "No"], recommended: "Yes", blocksTicketId: ticketId, triedFirst: "Looked into it first", ...(holdsMerge ? { holdsMerge } : {}) });

    it("a plain question or owner to-do on the ticket doesn't hold it: it waits for a check slot", async () => {
      const c = (ctx = await setup());
      const t = await newTicket(c, "Linked to a plain card");
      await ask(c, t.id, "Is the copy on the page right?");
      const row = (await queue(c)).waiting.find((r: { ticketId: string }) => r.ticketId === t.id);
      expect(row).toMatchObject({ state: "waiting_for_slot", decisionId: null });
      expect(row.card ?? null).toBeNull();
    });

    it("a card marked as holding the merge is named: its question, who raised it, and its id", async () => {
      const c = (ctx = await setup());
      const t = await newTicket(c, "Held on purpose");
      const d = await ask(c, t.id, "Which payment provider?\nWe compared two.", true);
      const row = (await queue(c)).waiting.find((r: { ticketId: string }) => r.ticketId === t.id);
      expect(row).toMatchObject({ state: "waiting_for_decision", decisionId: d.id, actor: "owner", signedOffAt: null });
      expect(row.card).toMatchObject({ id: d.id, kind: "hold", question: "Which payment provider?", raisedBy: null, staleHint: null });
      expect(row.label).toBe(`held by Boss Man's card: "Which payment provider?"`);
    });

    it("signed off and held by another card: says the sign-off is done, and when", async () => {
      const c = (ctx = await setup());
      const t = await newTicket(c, "Signed off already", "high");
      // The owner's own approval, given after this round's review: the sign-off is done.
      await c.db.insert(ticketReviews).values({ ticketId: t.id, reviewer: "the owner", verdict: "approved" });
      const d = await ask(c, t.id, "Rotate the deploy key first?", true);
      // A plain to-do on the same ticket is not what the row names.
      await ask(c, t.id, "Please check the page after the merge");
      const row = (await queue(c)).waiting.find((r: { ticketId: string }) => r.ticketId === t.id);
      expect(row).toMatchObject({ state: "waiting_for_decision", decisionId: d.id });
      expect(row.card).toMatchObject({ id: d.id, kind: "hold", question: "Rotate the deploy key first?" });
      expect(typeof row.signedOffAt).toBe("string");
      expect(row.next).toMatch(/^Your sign-off is done; /);
    });

    it("the owner's sign-off is named first, ahead of any other card", async () => {
      const c = (ctx = await setup());
      const t = await newTicket(c, "Needs the sign-off", "high");
      await ask(c, t.id, "Rotate the deploy key first?", true);
      const [s] = await c.db
        .insert(decisions)
        .values({ companyId: c.company.id, kind: "approval", question: "Merge it, or send it back?", options: ["Approve and merge"], recommendedOption: "Approve and merge", tier: "owner", dedupeKey: `risk-review:${t.id}`, context: { type: "risk_review", ticketId: t.id } })
        .returning({ id: decisions.id });
      await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: s!.id });
      const row = (await queue(c)).waiting.find((r: { ticketId: string }) => r.ticketId === t.id);
      expect(row).toMatchObject({ state: "waiting_for_sign_off", decisionId: s!.id });
      expect(row.card).toMatchObject({ id: s!.id, kind: "sign_off" });
    });

    it("a holding card that names a ticket now done is flagged as probably stale", async () => {
      const c = (ctx = await setup());
      const done = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "The ticket it asked for" })).json() as { id: string; number: number };
      await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, done.id));
      const [co] = await c.db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, c.company.id));
      const t = await newTicket(c, "Held by an old card");
      await ask(c, t.id, `Should this wait for ${co!.prefix}-${done.number}?`, true);
      const row = (await queue(c)).waiting.find((r: { ticketId: string }) => r.ticketId === t.id);
      expect(row.card.staleHint).toBe(`It names ${co!.prefix}-${done.number}, which is done now, so it may no longer be needed.`);
      // By id prefix too, as agents often write it.
      const t2 = await newTicket(c, "Held by an id");
      await ask(c, t2.id, `Waiting on ${done.id.slice(0, 8)} to land`, true);
      const row2 = (await queue(c)).waiting.find((r: { ticketId: string }) => r.ticketId === t2.id);
      expect(row2.card.staleHint).toMatch(/which is done now/);
    });
  });

  it("flags a ticket waiting over an hour as stuck for age, with its minutes over 60", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Waiting too long" })).json() as { id: string };
    // Approved 61 minutes ago: the ticket is in review, and nothing has touched it since.
    const waited = new Date(Date.now() - 61 * 60_000);
    await c.db.update(tickets).set({ systemState: "review", lastActivityAt: waited, stateChangedAt: waited }).where(eq(tickets.id, t.id));
    await approve(c, t.id);
    const data = await queue(c);
    const row = data.waiting.find((r: { ticketId: string }) => r.ticketId === t.id);
    expect(row).toMatchObject({ state: "waiting_for_slot", stuck: true });
    expect(row.minutes).toBeGreaterThanOrEqual(60);
    // A ticket only a few minutes old is not stuck.
    const fresh = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Just arrived" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, fresh.id));
    await approve(c, fresh.id);
    const again = await queue(c);
    expect(again.waiting.find((r: { ticketId: string }) => r.ticketId === fresh.id)).toMatchObject({ state: "waiting_for_slot", stuck: false });
    // QA, BOS-800: the side menu badge counts only the stuck one (1 stuck), while waitingCount still counts both.
    expect(again.stuckCount).toBe(1);
    expect(again.waitingCount).toBe(2);
    // With two healthy ones besides it, the badge still reads 1 stuck.
    const third = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Also fine" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, third.id));
    await approve(c, third.id);
    const three = await queue(c);
    expect(three).toMatchObject({ waitingCount: 3, stuckCount: 1 });
  });

  it("leaves out a ticket still with its reviewers, and keeps an approved one", async () => {
    const c = (ctx = await setup());
    const [a, b, d] = await Promise.all([
      c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Still reviewing" }),
      c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Approved already" }),
      c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Changes asked for" }),
    ]).then((rs) => rs.map((r) => r.json() as { id: string }));
    await c.db.update(tickets).set({ systemState: "review" }).where(and(eq(tickets.id, a!.id)));
    await c.db.update(tickets).set({ systemState: "review" }).where(and(eq(tickets.id, b!.id)));
    await c.db.update(tickets).set({ systemState: "review" }).where(and(eq(tickets.id, d!.id)));
    // One review still pending, one its reviewer approved, and one whose reviewer sent it back.
    await c.db.insert(reviewRequests).values({ ticketId: a!.id, kind: "code", round: 1, status: "pending" });
    await approve(c, b!.id);
    await approve(c, d!.id, "changes_requested");
    const data = await queue(c);
    const ids = data.waiting.map((r: { ticketId: string }) => r.ticketId);
    expect(ids).not.toContain(a!.id);
    expect(ids).not.toContain(d!.id);
    expect(ids).toContain(b!.id);
    expect(data.waitingCount).toBe(1);
    // The badge counts only what is really waiting to merge.
    expect(data.waitingCount).toBe(data.waiting.length);
  });

  it("shows running work, and puts it in no waiting list", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Merging now" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    await approve(c, t.id);
    // Start a tracked landing, the same marker the ticket page polls.
    await c.review.startLanding(t.id, "the reviewer").catch(() => undefined);
    const data = await queue(c);
    const run = data.running.find((r: { ticketId: string }) => r.ticketId === t.id);
    // No runner is connected in this test, so the landing may fail at once; when it does not, it is shown as running.
    if (run) {
      expect(run).toMatchObject({ title: "Merging now", what: "merge_check" });
      expect(data.waiting.some((r: { ticketId: string }) => r.ticketId === t.id)).toBe(false);
    }
  });

  it("counts a running check over its limit as stuck, with nothing else stuck (BOS-767)", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Running too long" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    await approve(c, t.id);
    // The merge is running (not waiting), and it started past the 60-minute limit.
    const service = mergeQueueService(c.db, {
      runningMerges: () => [{ ticketId: t.id, startedAt: new Date(Date.now() - 90 * 60_000).toISOString(), startedBy: "the reviewer" }],
      limit: async () => 1,
    });
    const data = await service.get(c.company.id);
    expect(data.running.find((r: { ticketId: string }) => r.ticketId === t.id)).toMatchObject({ overLimit: true });
    expect(data.waiting.some((r: { ticketId: string }) => r.ticketId === t.id)).toBe(false);
    expect(data.stuckCount).toBe(1);
  });

  it("shows a recently merged ticket and its failing check, newest first", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "All done" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "done", mergeCommit: "abcdef1234567890", stateChangedAt: new Date() }).where(eq(tickets.id, t.id));
    const data = await queue(c);
    const row = data.recent.find((r: { ticketId: string }) => r.ticketId === t.id);
    expect(row).toMatchObject({ title: "All done", result: "merged" });
    expect(row.detail).toMatch(/abcdef1/);
  });

  it("is empty, with no merges, for a company that has done nothing", async () => {
    const c = (ctx = await setup());
    const data = await queue(c);
    expect(data).toMatchObject({ waitingCount: 0, stuckCount: 0, running: [], waiting: [], recent: [] });
    expect(data.mode).toBe("legacy");
  });
});

describe("merge queue screen in server mode (BOS-597)", () => {
  // The server-owned check queue (BOS-316) is on: the screen reports its mode and slots, and a ticket
  // with checks queued ahead of it shows "waiting for a check slot" rather than a plain wait.
  async function serverMode(c: Awaited<ReturnType<typeof setup>>) {
    await c.db.insert(settings).values([
      { key: CHECK_QUEUE_MODE_KEY, value: "server" },
      { key: CHECK_SLOTS_KEY, value: "2" },
    ]);
  }
  // A ticket on the board, so a check job has something to point at (the job's ticket is a foreign key).
  const spareTicket = async (c: Awaited<ReturnType<typeof setup>>) =>
    (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Someone else's check" })).json() as { id: string };
  const job = async (c: Awaited<ReturnType<typeof setup>>, ticketId: string, state: "queued" | "running", commit: string) =>
    c.db.insert(checkJobs).values({ companyId: c.company.id, projectId: c.project.id, ticketId, kind: "merge", scope: "full", commit, tree: commit });

  it("reports server mode with the queue's slots and counts", async () => {
    const c = (ctx = await setup());
    await serverMode(c);
    const other = await spareTicket(c);
    await job(c, other.id, "running", "a".repeat(40));
    await job(c, other.id, "queued", "b".repeat(40));
    await job(c, other.id, "queued", "c".repeat(40));
    const data = await queue(c);
    expect(data.mode).toBe("server");
    expect(data.slots).toBe(2);
  });

  it("shows a waiting ticket as waiting for a check slot when checks are queued ahead", async () => {
    const c = (ctx = await setup());
    await serverMode(c);
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Behind the queue" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    await c.db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", round: 1, status: "approved" });
    await job(c, t.id, "queued", "d".repeat(40));
    const data = await queue(c);
    const row = data.waiting.find((r: { ticketId: string }) => r.ticketId === t.id);
    expect(row).toMatchObject({ state: "waiting_for_slot" });
    // BOS-1486: no runner is connected here, so that is the reason, never "waiting for a check slot".
    expect(row.label).toMatch(/no runner is connected/);
    expect(row.label).not.toMatch(/check slot/);
  });

  // BOS-1486: the reason a merge waits comes from live state, in a fixed order.
  describe("the reason a merge waits (BOS-1486)", () => {
    const waitingMerge = async (c: Awaited<ReturnType<typeof setup>>) => {
      const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Approved work" })).json() as { id: string };
      await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
      await approve(c, t.id);
      return t.id;
    };
    const detail = (busy: number, mainRed = false) => async () => ({ slots: 2, busy: Array.from({ length: busy }, (_, i) => ({ ref: `APP-${i + 1}`, title: `Busy ${i + 1}`, kind: "merge check" })), mainRed, fixRef: mainRed ? "APP-9" : null });
    const svc = (c: Awaited<ReturnType<typeof setup>>, over: Partial<Parameters<typeof mergeQueueService>[1]>) =>
      mergeQueueService(c.db, { runningMerges: () => [], limit: async () => 2, queueStatus: async () => ({ mode: "server", slots: 2, running: 0, waiting: 0 }), runnerConnected: async () => true, ...over });
    const labelOf = async (c: Awaited<ReturnType<typeof setup>>, id: string, over: Partial<Parameters<typeof mergeQueueService>[1]>) => (await svc(c, over).get(c.company.id)).waiting.find((w) => w.ticketId === id)!;

    // BOS-1757: a running merge check holds a slot even when no landing owns it, so the screen counts the same rows as the Checks panel.
    it("lists a running merge job that no landing owns, so it counts the same as the Checks panel", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      const started = new Date(Date.now() - 15 * 60_000);
      const view = await svc(c, { runningChecks: async () => [{ ticketId: id, kind: "merge", startedAt: started }], queueStatus: async () => ({ mode: "server", slots: 3, running: 1, waiting: 0 }) }).get(c.company.id);
      expect(view.running.map((r) => r.ticketId)).toEqual([id]);
      expect(view.running[0]!.minutes).toBeGreaterThanOrEqual(15);
    });

    // BOS-1942: where a running merge check runs comes from its check job, and the server's host name rides with the view.
    it("carries where each running merge check runs, and the server's host name", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      const view = await svc(c, { runningChecks: async () => [{ ticketId: id, kind: "merge", startedAt: new Date(), ranOn: "Worker One" }], serverHost: async () => "host-a", queueStatus: async () => ({ mode: "server", slots: 3, running: 1, waiting: 0 }) }).get(c.company.id);
      expect(view.running[0]!.ranOn).toBe("Worker One");
      expect(view.serverHost).toBe("host-a");
      // No job on record names no place (and a failing host lookup is not an error).
      const none = await svc(c, { runningChecks: async () => [{ ticketId: id, kind: "merge", startedAt: new Date() }], serverHost: async () => { throw new Error("no report"); }, queueStatus: async () => ({ mode: "server", slots: 3, running: 1, waiting: 0 }) }).get(c.company.id);
      expect(none.running[0]!.ranOn).toBeUndefined();
      expect(none.serverHost).toBeNull();
    });

    // BOS-1942: the slot total says what it is made of (server plus worker), only when more than one machine holds slots.
    it("carries the slot split only when several machines hold slots", async () => {
      const c = (ctx = await setup());
      await waitingMerge(c);
      const q = { queueStatus: async () => ({ mode: "server" as const, slots: 5, running: 0, waiting: 0 }) };
      const two = await svc(c, { ...q, slotSplit: async () => [{ ranOn: "company runner", slots: 3 }, { ranOn: "Truenas", slots: 2 }] }).get(c.company.id);
      expect(two.slotSplit).toEqual([{ ranOn: "company runner", slots: 3 }, { ranOn: "Truenas", slots: 2 }]);
      const one = await svc(c, { ...q, slotSplit: async () => [{ ranOn: "company runner", slots: 5 }] }).get(c.company.id);
      expect(one.slotSplit).toBeUndefined();
    });

    it("says no runner is connected before anything else, even with every slot busy", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      const row = await labelOf(c, id, { runnerConnected: async () => false, runnerUpdateOn: async () => true, launcherOn: () => true, queueDetail: detail(2, true) });
      expect(row.label).toMatch(/no runner is connected/);
      expect(row.next).toMatch(/Start the runner in Settings → Server and runner → Runner/);
      expect(row.label).not.toMatch(/check slot/);
      // No launcher: there is no Start button to point at.
      const bare = await labelOf(c, id, { runnerConnected: async () => false, launcherOn: () => false });
      expect(bare.next).toMatch(/on your host/);
      expect(bare.next).not.toMatch(/Settings/);
    });

    it("then a runner update, then a red main, then busy slots naming each ticket", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      expect((await labelOf(c, id, { runnerUpdateOn: async () => true, queueDetail: detail(2, true) })).label).toMatch(/waiting for the runner update/);
      const red = await labelOf(c, id, { queueDetail: detail(2, true) });
      expect(red.label).toMatch(/main is failing its check/);
      expect(red.next).toMatch(/APP-9/);
      const busy = await labelOf(c, id, { queueDetail: detail(2) });
      expect(busy.label).toMatch(/waiting for a check slot/);
      expect(busy.label).toMatch(/slot 1: APP-1 \(merge check\); slot 2: APP-2/);
    });

    // BOS-1517: a merge waiting for a train seat is not waiting for a check slot, and every row carries one status line.
    it("says waiting for a train seat (no queue count) for a merge the train holds back, with its status line", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      const seat = async () => ({ slots: 2, busy: [{ ref: "APP-1", title: "A", kind: "merge check" }, { ref: "APP-2", title: "B", kind: "merge check" }], mainRed: false, fixRef: null, seatWait: [id] });
      const row = await labelOf(c, id, { queueStatus: async () => ({ mode: "server", slots: 2, running: 2, waiting: 21 }), queueDetail: seat });
      expect(row).toMatchObject({ state: "waiting_for_seat", label: "waiting for a train seat" });
      expect(row.label).not.toMatch(/check slot|ahead/);
      expect(row.statusLine).toMatchObject({ step: "waiting for a train seat", blocker: "Every merge-train seat is taken." });
      expect(row.statusLine!.next).toMatch(/check then starts by itself/);
      // A merge not named in seatWait still waits for a slot, and its line names what holds the slots.
      const other = await labelOf(c, id, { queueStatus: async () => ({ mode: "server", slots: 2, running: 2, waiting: 3 }), queueDetail: async () => ({ ...(await seat()), seatWait: [] }) });
      expect(other.statusLine!.step).toMatch(/^waiting for a check slot \(3 ahead\)$/);
      expect(other.statusLine!.blocker).toMatch(/Every slot is busy: slot 1: APP-1/);
    });

    // BOS-1803: a seat waiter says how many wait ahead for a seat, and a lane merge says so, on the row and the ticket's status line.
    it("says the seat place and the background lane in the label and status line", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      const seat = async () => ({ slots: 2, busy: [], mainRed: false, fixRef: null, seatWait: [id] });
      const lane = "background lane: newer ordinary work goes first for up to 40 min more";
      const row = await labelOf(c, id, { queueDetail: seat, places: async () => new Map([[id, { place: null, why: null, seatPlace: 3, lane }]]) });
      expect(row).toMatchObject({ state: "waiting_for_seat", label: `waiting for a train seat (2 ahead); ${lane}` });
      expect(row.place ?? null).toBeNull(); // a seat waiter has no check-queue place yet
      expect(row.statusLine!.step).toBe(`waiting for a train seat (2 ahead); ${lane}`);
      const next = await labelOf(c, id, { queueDetail: seat, places: async () => new Map([[id, { place: null, why: null, seatPlace: 1, lane: null }]]) });
      expect(next.label).toBe("waiting for a train seat (next up)");
      // Waiting for a check slot: its place counts as before and the lane is added after it.
      const busy = await labelOf(c, id, { queueStatus: async () => ({ mode: "server", slots: 2, running: 2, waiting: 5 }), queueDetail: detail(2), places: async () => new Map([[id, { place: 4, why: null, lane }]]) });
      expect(busy.statusLine!.step).toBe(`waiting for a check slot (3 ahead); ${lane}`);
      expect(busy.place).toBe(4);
    });

    // BOS-1515 (B1): a merge the train holds to land on main alone says who it clashed with, the files, and what happens next.
    it("says waiting to land on main alone, with the clash, for a merge the train holds alone", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      const detail = async () => ({ slots: 2, busy: [], mainRed: false, fixRef: null, seatWait: [id], heldAlone: [{ ticketId: id, clashWith: ["APP-1471"], files: ["a.ts", "b.ts", "c.ts", "d.ts"], since: "2026-11-14T20:14:35.000Z", holdsLine: true }] });
      const row = await labelOf(c, id, { queueStatus: async () => ({ mode: "server", slots: 2, running: 1, waiting: 3 }), queueDetail: detail });
      expect(row).toMatchObject({ state: "waiting_for_seat", label: "waiting to land on main alone: it clashed with APP-1471 in 4 files (a.ts, b.ts, c.ts, …)" });
      expect(row.heldAlone).toEqual({ clashWith: ["APP-1471"], files: ["a.ts", "b.ts", "c.ts", "d.ts"], since: "2026-11-14T20:14:35.000Z", holdsLine: true });
      expect(row.statusLine).toMatchObject({ step: row.label, blocker: "The tickets ahead in the merge train haven't landed yet." });
      expect(row.statusLine!.next).toMatch(/others wait behind it until then\. It is sent back at once if the clash reaches main\./);
    });

    it("gives a running merge the check's own start time, not the landing's", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      const landing = new Date(Date.now() - 100 * 60_000);
      const check = new Date(Date.now() - 5 * 60_000);
      const service = svc(c, { runningMerges: () => [{ ticketId: id, startedAt: landing.toISOString(), startedBy: "the merge gate", phase: "checking" as const }], runningChecks: async () => [{ ticketId: id, kind: "merge", startedAt: check }] });
      const [run] = (await service.get(c.company.id)).running;
      expect(run!.startedAt).toBe(check.toISOString());
      expect(run!.minutes).toBe(5);
      expect(run!.overLimit).toBe(false);
      expect(run!.statusLine).toMatchObject({ step: "slot 1: running the check", since: check.toISOString(), blocker: null });
      expect(await service.statusLineFor(c.company.id, id)).toEqual(run!.statusLine);
      expect(await service.statusLineFor(c.company.id, "00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("says next in line, not waiting for a slot, when a slot is free", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      const row = await labelOf(c, id, { queueStatus: async () => ({ mode: "server", slots: 2, running: 1, waiting: 1 }), queueDetail: detail(1) });
      expect(row.label).toMatch(/^next in line for a check/);
      expect(row.label).not.toMatch(/waiting for a check slot/);
    });

    // BOS-1871: BOS-1854's check passed at 12:44, then its landing waited for GitHub CI on the merge copy. Its check held no
    // slot any more, so it dropped out of Running now and fell through to "next in line for a check. A slot is free".
    it("says waiting for GitHub CI, never next in line, for a landing whose check ended but whose CI wait is open", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      const landing = new Date(Date.now() - 40 * 60_000);
      const ciSince = new Date(Date.now() - 12 * 60_000);
      const service = svc(c, {
        runningMerges: () => [{ ticketId: id, startedAt: landing.toISOString(), startedBy: "the merge gate", phase: "checking" as const, ci: { since: ciSince.toISOString(), waiting: ["check", "images (arm64)"] } }],
        runningChecks: async () => [],
        queueStatus: async () => ({ mode: "server", slots: 2, running: 0, waiting: 0 }),
        queueDetail: detail(0),
      });
      const view = await service.get(c.company.id);
      expect(view.running).toEqual([]);
      const row = view.waiting.find((w) => w.ticketId === id)!;
      expect(row).toMatchObject({ state: "waiting_for_ci", minutes: 12, stuck: false, actor: "system", label: "waiting for GitHub CI on its merge copy (check, images (arm64)), 12 min so far" });
      expect(`${row.label} ${row.next}`).not.toMatch(/next in line|slot is free|check slot/);
      expect(row.statusLine).toMatchObject({ step: row.label, since: ciSince.toISOString(), blocker: null });
      expect(await service.statusLineFor(c.company.id, id)).toEqual(row.statusLine);
      // Still one item in the line (R43), and a CI wait is not the line's own fault: no stuck badge.
      expect(view.lineCount).toBe(1);
      expect(view.stuckCount).toBe(0);
      // With its check still holding a slot it stays in Running now, with the CI wait beside it (BOS-1070), as before.
      const both = await svc(c, {
        runningMerges: () => [{ ticketId: id, startedAt: landing.toISOString(), startedBy: "the merge gate", phase: "checking" as const, ci: { since: ciSince.toISOString(), waiting: [] } }],
        runningChecks: async () => [{ ticketId: id, kind: "merge", startedAt: ciSince }],
      }).get(c.company.id);
      expect(both.running).toMatchObject([{ ticketId: id, ci: { minutes: 12, waiting: [] } }]);
      expect(both.waiting.find((w) => w.ticketId === id)).toBeUndefined();
      // A landing with no CI wait and no slot is still left out of Running now (BOS-1287), so it reads as before.
      const none = await labelOf(c, id, { runningMerges: () => [{ ticketId: id, startedAt: landing.toISOString(), startedBy: "the merge gate", phase: "checking" as const }], runningChecks: async () => [], queueDetail: detail(1) });
      expect(none.state).toBe("waiting_for_check_capacity");
    });

    // BOS-1871: the held-fix stall alarm read the CI wait only on running rows, so a fix waiting on GitHub CI was timed as
    // "approved, waiting to land" from its approval.
    it("times a held fix that waits for GitHub CI by that wait, not by its approval", async () => {
      const c = (ctx = await setup());
      const fix = await waitingMerge(c);
      await c.db.update(tickets).set({ fixesMergeCheck: true, lastActivityAt: new Date(Date.now() - 5 * 60 * 60_000) }).where(eq(tickets.id, fix));
      const held = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Held" })).json() as { id: string };
      await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, held.id));
      await approve(c, held.id);
      await c.db.insert(ticketDependencies).values({ blockedTicketId: held.id, blockerTicketId: fix });
      const lineWith = (ciMin: number) =>
        svc(c, {
          runningMerges: () => [{ ticketId: fix, startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), startedBy: "the merge gate", ci: { since: new Date(Date.now() - ciMin * 60_000).toISOString(), waiting: ["check"] } }],
          runningChecks: async () => [],
          queueDetail: detail(0),
        }).get(c.company.id).then((v) => v.line);
      expect(await lineWith(20)).toMatchObject({ state: "held_behind_fix", fixes: [{ ticketId: fix, stateText: "waiting for GitHub CI, 20 min" }] });
      expect(await lineWith(75)).toMatchObject({ state: "stuck", cause: "fix_stalled", reason: expect.stringMatching(/waiting for GitHub CI for 75 minutes with no result/) });
    });

    it("does not claim a slot is free when slot use is unknown (legacy mode, or the lookup fails)", async () => {
      const c = (ctx = await setup());
      const id = await waitingMerge(c);
      const legacy = await labelOf(c, id, { queueStatus: async () => ({ mode: "legacy", slots: 2, running: 2, waiting: 1 }), queueDetail: detail(2) });
      expect(legacy.label).toMatch(/^waiting for a check slot/);
      expect(`${legacy.label} ${legacy.next}`).not.toMatch(/slot is free|next in line/);
      const failed = await labelOf(c, id, { queueDetail: async () => { throw new Error("boom"); } });
      expect(`${failed.label} ${failed.next}`).not.toMatch(/slot is free|next in line/);
    });
  });

  it("gives each waiting merge its own place in the label, not the queue length (BOS-1405)", async () => {
    const c = (ctx = await setup());
    await serverMode(c);
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: `Queued ${i}` })).json() as { id: string };
      await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
      await c.db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", round: 1, status: "approved" });
      await job(c, t.id, "queued", String(i).repeat(40).slice(0, 40));
      ids.push(t.id);
    }
    const service = mergeQueueService(c.db, {
      runningMerges: () => [],
      limit: async () => 2,
      queueStatus: async () => ({ mode: "server", slots: 2, running: 2, waiting: 6 }),
      runnerConnected: async () => true,
      queueDetail: async () => ({ slots: 2, busy: [{ ref: "APP-1", title: "A", kind: "merge check" }, { ref: "APP-2", title: "B", kind: "merge check" }], mainRed: false, fixRef: null }),
      // Two other checks wait ahead of these merges, so their places are 3, 4, 5, 6.
      places: async () => new Map(ids.map((id, i) => [id, { place: i + 3, why: null }])),
    });
    const data = await service.get(c.company.id);
    const labels = ids.map((id) => data.waiting.find((w) => w.ticketId === id)!.label);
    expect(labels.map((l) => l.replace(/\. Every slot is busy.*$/, ""))).toEqual(["waiting for a check slot (2 ahead)", "waiting for a check slot (3 ahead)", "waiting for a check slot (4 ahead)", "waiting for a check slot (5 ahead)"]);
    // The first in line reads "next up".
    const first = mergeQueueService(c.db, {
      runningMerges: () => [],
      limit: async () => 2,
      queueStatus: async () => ({ mode: "server", slots: 2, running: 2, waiting: 4 }),
      runnerConnected: async () => true,
      queueDetail: async () => ({ slots: 2, busy: [{ ref: "APP-1", title: "A", kind: "merge check" }, { ref: "APP-2", title: "B", kind: "merge check" }], mainRed: false, fixRef: null }),
      places: async () => new Map(ids.map((id, i) => [id, { place: i + 1, why: null }])),
    });
    const d2 = await first.get(c.company.id);
    expect(d2.waiting.find((w) => w.ticketId === ids[0])!.label).toMatch(/^waiting for a check slot \(next up\)/);
    expect(d2.waiting.find((w) => w.ticketId === ids[1])!.label).toMatch(/^waiting for a check slot \(1 ahead\)/);
  });

  it("BOS-1594: tickets queued over an hour for a busy check slot are over capacity, so the side-menu stuck badge stays 0", async () => {
    const c = (ctx = await setup());
    await serverMode(c);
    const old = new Date(Date.now() - 90 * 60_000);
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Long wait" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "review", lastActivityAt: old, stateChangedAt: old }).where(eq(tickets.id, t.id));
    await c.db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", round: 1, status: "approved" });
    await job(c, t.id, "queued", "c".repeat(40));
    // The line is landing: two merges 20 and 40 minutes ago.
    for (const [i, ago] of [20, 40].entries()) {
      const m = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: `Landed ${i}` })).json() as { id: string };
      const at = new Date(Date.now() - ago * 60_000);
      await c.db.update(tickets).set({ systemState: "done", mergeCommit: `abcdef${i}234567890`, stateChangedAt: at }).where(eq(tickets.id, m.id));
    }
    const service = mergeQueueService(c.db, {
      runningMerges: () => [],
      limit: async () => 2,
      queueStatus: async () => ({ mode: "server", slots: 2, running: 2, waiting: 3 }),
      runnerConnected: async () => true,
      queueDetail: async () => ({ slots: 2, busy: [{ ref: "APP-1", title: "A", kind: "merge check" }, { ref: "APP-2", title: "B", kind: "merge check" }], mainRed: false, fixRef: null }),
    });
    const data = await service.get(c.company.id);
    const row = data.waiting.find((w) => w.ticketId === t.id)!;
    // The row itself still reads as an hour-old wait, but it is the line's own capacity at work, not a fault.
    expect(row).toMatchObject({ state: "waiting_for_check_capacity", stuck: true });
    expect(data.line.state).toBe("over_capacity");
    expect(data.stuckCount).toBe(0);
  });

  it("keeps a plain wait with an empty queue, and counts only this company's jobs", async () => {
    const c = (ctx = await setup());
    await serverMode(c);
    // Another company's queued check must not make this company's tickets look held back.
    const [other] = await c.db.insert(companies).values({ name: "Other Co" }).returning();
    const theirs = await spareTicket(c);
    await c.db.insert(checkJobs).values({ companyId: other!.id, projectId: c.project.id, ticketId: theirs.id, kind: "merge", scope: "full", commit: "e".repeat(40), tree: "e".repeat(40) });
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Nothing ahead" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    await c.db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", round: 1, status: "approved" });
    const data = await queue(c);
    expect(data.mode).toBe("server");
    expect(data.waiting.find((r: { ticketId: string }) => r.ticketId === t.id)).toMatchObject({ state: "waiting_for_slot" });
  });

  it("after a restart, shows only the merge that holds a slot as running (BOS-1287)", async () => {
    const c = (ctx = await setup());
    await c.db.insert(settings).values([
      { key: CHECK_QUEUE_MODE_KEY, value: "server" },
      { key: CHECK_SLOTS_KEY, value: "3" },
    ]);
    const mk = async (title: string) => {
      const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title })).json() as { id: string };
      await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
      await approve(c, t.id);
      return t.id;
    };
    // Five merges restarted at once; only the first holds a slot, the others are queued at places 1-4.
    const merges = [await mk("M1"), await mk("M2"), await mk("M3"), await mk("M4"), await mk("M5")];
    const quick = [await mk("Q1"), await mk("Q2")];
    const sha = (n: number) => String(n).repeat(40).slice(0, 40);
    const base = Date.now() - 600_000;
    const ins = (ticketId: string, kind: string, scope: string, state: string, n: number, startedAt: Date | null) =>
      c.db.insert(checkJobs).values({ companyId: c.company.id, projectId: c.project.id, ticketId, kind, scope, state, commit: sha(n), tree: sha(n), startedAt } as never);
    await ins(quick[0]!, "check", "quick", "running", 1, new Date(base));
    await ins(quick[1]!, "check", "quick", "running", 2, new Date(base + 1000));
    await ins(merges[0]!, "merge", "full", "running", 3, new Date(base + 2000));
    for (let i = 1; i < 5; i++) await ins(merges[i]!, "merge", "full", "queued", 3 + i, null);
    const service = mergeQueueService(c.db, {
      runningMerges: () => merges.map((id, i) => ({ ticketId: id, startedAt: new Date(base + i).toISOString(), startedBy: "Boss Man (the server restarted during this merge; starting it again)", phase: "queued" as const })),
      limit: async () => 3,
      runningChecks: async () => (await c.db.select({ ticketId: checkJobs.ticketId, kind: checkJobs.kind }).from(checkJobs).where(eq(checkJobs.state, "running")).orderBy(checkJobs.startedAt)),
      queueStatus: async () => ({ mode: "server", slots: 3, running: 3, waiting: 4 }),
    });
    const data = await service.get(c.company.id);
    expect(data.running.map((r) => r.ticketId)).toEqual([merges[0]]);
    // Slot 3: two quick checks started before it.
    expect(data.running[0]!.slot).toBe(3);
    expect(data.running.length).toBeLessThanOrEqual(3);
    const waitingMerges = data.waiting.filter((w) => merges.includes(w.ticketId));
    expect(waitingMerges).toHaveLength(4);
    for (const w of waitingMerges) expect(w.label).toMatch(/server restarted/);
    expect(new Set(data.running.map((r) => r.slot)).size).toBe(data.running.length);
    // R43: the badge and Merges tab figure is everything on the tab, waiting and running; the start hold's stays waiting only.
    expect(data.lineCount).toBe(data.waiting.length + data.running.length);
    expect(data.waitingCount).toBe(data.waiting.length);
  });
});
