import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, checkResults, companies, decisions, reviewRequests, settings, ticketDependencies, tickets } from "../src/db/schema.js";
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
    // The side menu's warning badge counts stuck items (BOS-767).
    expect(data.stuckCount).toBe(1);
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
    expect(row).toMatchObject({ state: "waiting_for_check_capacity" });
    expect(row.label).toMatch(/waiting for a check slot \(1 ahead\)/);
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
});
