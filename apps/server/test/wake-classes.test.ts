// Wake classes (DR-002, BOS-296): every reason has a class, and the class decides what the
// scheduler may drop, replace, age and reserve a slot for.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { costEvents, decisions, runs, tickets, wakes } from "../src/db/schema.js";
import { WAKE_CLASS, wakeClass } from "../src/services/wake-classes.js";
import type { Limits } from "../src/services/scheduler.js";
import { HELD_COMPANY } from "../src/services/fair-share.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(limits: Partial<Limits> = {}) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0, ...limits }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "run.start") commands.push(c);
    return true;
  });
  const agent = async (name: string) => (await req("POST", `/api/companies/${company.id}/agents`, { name })).json() as { id: string };
  return { ...built, db, close, req, company, ceo, project, commands, agent };
}

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : f.endsWith(".ts") ? [path.join(dir, f)] : []));
const SRC = path.join(__dirname, "..", "src");

describe("wake classes: the table", () => {
  // Strings that follow `reason:` in the source but are never a wake's reason.
  const NOT_WAKE_REASONS = new Set([
    "runner offline",
    "not_found",
    "foreign_agent",
    // The merge line's pause reason (R44, merge-queue.ts), not a wake's reason.
    "a server update",
    "agent or company gone",
    "a ticket it waited on finished",
    "the owner wrote on this ticket",
    // Why a card was flagged "may be out of date" (BOS-1161, stale-requests.ts), not a wake's reason.
    "a ticket it is about merged",
    "the runners were rebuilt",
    "the ticket it is about changed state",
    "snoozed twice in a row and still tripping",
    "runner update",
    // Why a runner restarted (BOS-594), and the setting-change drain's label: not wakes.
    "setting change",
    "host",
    "crash or out of memory",
    "unknown",
    "it is no longer at its link",
    "it has no pinned version to check",
    "the file at the link has changed since the review",
    "the skill it would replace has been edited since this was proposed",
    "the skill it would replace has been deleted since the review",
    "the stored files no longer match their fingerprint",
    // A command's options in the owner-replies service (BOS-425), not a wake.
    "unanswered at 5 minutes, the agent is woken again",
    "unanswered at 10 minutes, the CEO is asked",
    // The reasons a dropped do-after/do-before link is reported to its raiser (BOS-625), not wakes.
    "another company",
    "not open",
    "unknown",
    // The reasons written on a ticket's history row by a system move (BOS-898), not wakes.
    "what it waited on is resolved",
    "what it waited on finished",
    // The reason in the detail of the history row for a company set to fence Off at start (BOS-940), not a wake.
    "runner_cannot_fence",
    // The status reason written on a wake the WIP limit refused (BOS-1180), not a wake reason.
    "held by the WIP limit",
    // The reason of a "can't tell" go-live answer (BOS-1644), not a wake.
    "nothing is recorded yet about which version the server runs",
    // The status reason on a wake the maintenance hold stopped holding (BOS-1414), not a wake reason.
    "released: the runner update waited past its deadline and is waiting for the owner's answer; new runs are not held for it",
  ]);

  it("classifies every reason the server uses to wake an agent", () => {
    const found = new Map<string, string>();
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/export const \w*REASON = "([^"]+)"/g)) found.set(m[1]!, file);
      // Plain lower-case words only: the sentences after `reason:` elsewhere are refusals shown to people.
      for (const m of text.matchAll(/\breason: "([a-z_][a-z_ -]*)"/g)) found.set(m[1]!, file);
    }
    // "update pending" is the maintenance hold's label; no_wrapup and too_early are the refusal codes of the
    // stop-stragglers endpoint (BOS-1238). None is a wake.
    // no_update, agents_running and no_checks are the refusal codes of the update-now endpoint (BOS-1600).
    for (const r of ["update pending", "no_wrapup", "too_early", "no_update", "agents_running", "no_checks"]) found.delete(r); // the maintenance hold's label, not a wake
    for (const r of NOT_WAKE_REASONS) found.delete(r);
    const missing = [...found].filter(([r]) => !(r in WAKE_CLASS));
    const unclassified = missing.map(([r, f]) => `${r} (${path.relative(SRC, f)})`);
    // The message is the exact fix (BOS-1727): a line per reason for the WAKE_CLASS table, or the NOT_WAKE_REASONS list if it is no wake.
    const fix =
      `For a wake reason, add to WAKE_CLASS in apps/server/src/services/wake-classes.ts (class waiting, scheduled or agent; see the table's header):\n` +
      missing.map(([r]) => `  ${/^[a-z_]+$/.test(r) ? r : JSON.stringify(r)}: "<class>",`).join("\n") +
      `\nIf it is not a wake's reason, add ${missing.map(([r]) => JSON.stringify(r)).join(", ")} to NOT_WAKE_REASONS in apps/server/test/wake-classes.test.ts.`;
    expect(unclassified, fix).toEqual([]);
  });

  it("puts the reasons DR-002 names in their classes", () => {
    expect(["decision", "alert", "review requested", "woken by owner"].map(wakeClass)).toEqual(["waiting", "waiting", "waiting", "waiting"]);
    expect(["ticket watch", "check due", "tree stopped", "missed work", "resume", "watchdog"].map(wakeClass).every((c) => c === "scheduled")).toBe(true);
    expect(["nudge", "assigned", "unblocked", "feedback"].map(wakeClass).every((c) => c === "agent")).toBe(true);
  });
});

describe("wake classes: loop protection raises an alert for someone who is waiting", () => {
  it("keeps a card wake past the chain-depth limit (the old code dropped it) and still alerts", async () => {
    ctx = await setup({ maxDepth: 1, agent: 5 });
    await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "start" });
    await ctx!.scheduler.tick();
    await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "follow-up", causedByRunId: ctx!.commands[0]!.runId });
    await ctx!.scheduler.tick();
    const deep = ctx!.commands[1]!.runId;
    const card = await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "decision", causedByRunId: deep, note: "A card." });
    expect(card).toMatchObject({ status: "queued", outcome: "queued", causationDepth: 2 });
    expect((await ctx!.db.select().from(decisions))[0]!.question).toMatch(/looks like a loop/);
    // An agent-started wake at the same depth is still dropped, and says so.
    expect(await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "nudge", causedByRunId: deep })).toMatchObject({ status: "dropped", outcome: "dropped" });
  });

  it("keeps a card wake past the self-wake limit (the old code dropped it)", async () => {
    ctx = await setup({ selfWakesPer10Min: 1, maxDepth: 100, agent: 10 });
    await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "start" });
    await ctx!.scheduler.tick();
    const run = ctx!.commands[0]!.runId;
    await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "self", causedByRunId: run });
    expect(await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "self", causedByRunId: run })).toMatchObject({ outcome: "dropped" });
    expect(await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "decision", causedByRunId: run, note: "A card." })).toMatchObject({ outcome: "queued" });
  });
});

describe("wake classes: scheduled wakes", () => {
  it("replaces an unstarted scheduled wake with the newer one, and says so", async () => {
    ctx = await setup();
    const t = (await ctx!.req("POST", `/api/projects/${ctx!.project.id}/tickets`, { title: "Slow job" })).json();
    const first = await ctx!.scheduler.notify(ctx!.ceo.id, { ticketId: t.id, reason: "check due", note: "Check due (1 of 3)" });
    const second = await ctx!.scheduler.notify(ctx!.ceo.id, { ticketId: t.id, reason: "check due", note: "Check due (2 of 3)" });
    expect(second).toMatchObject({ id: first.id, outcome: "merged", note: "Check due (2 of 3)" });
    expect(await ctx!.db.select().from(wakes).where(eq(wakes.reason, "check due"))).toHaveLength(1);
  });

  it("ages a waiting scheduled wake past newer, higher-priority agent wakes", async () => {
    ctx = await setup({ instance: 1, company: 1 });
    const watcher = await ctx!.agent("Watcher");
    const worker = await ctx!.agent("Worker");
    const old = await ctx!.scheduler.wake({ agentId: watcher.id, reason: "missed work", priority: 1, note: "old" });
    const fresh = await ctx!.scheduler.wake({ agentId: worker.id, reason: "assigned", priority: 2, note: "fresh" });
    // With no ageing the priority-2 wake would go first; 40 minutes of waiting is worth +2.
    await ctx!.db.update(wakes).set({ createdAt: new Date(Date.now() - 40 * 60_000) }).where(eq(wakes.id, old.id));
    await ctx!.scheduler.tick();
    expect(ctx!.commands.map((c) => c.agentId)).toEqual([watcher.id]);
    expect((await ctx!.db.select().from(wakes).where(eq(wakes.id, fresh.id)))[0]!.status).toBe("queued");
  });

  it("ranks a wake for an urgent ticket one higher within its class (BOS-346)", async () => {
    ctx = await setup({ instance: 1, company: 1 });
    const a = await ctx!.agent("A");
    const b = await ctx!.agent("B");
    const ta = (await ctx!.req("POST", `/api/projects/${ctx!.project.id}/tickets`, { title: "Routine" })).json();
    const tb = (await ctx!.req("POST", `/api/projects/${ctx!.project.id}/tickets`, { title: "Urgent" })).json();
    await ctx!.db.update(tickets).set({ urgent: true, assigneeAgentId: b.id, systemState: "ready" }).where(eq(tickets.id, tb.id));
    // Each ticket belongs to its agent: a wake on a parked or reassigned ticket is dropped (BOS-1791).
    await ctx!.db.update(tickets).set({ assigneeAgentId: a.id, systemState: "ready" }).where(eq(tickets.id, ta.id));
    // Same stored priority and the routine one is older: without the urgent bonus it would start first.
    await ctx!.scheduler.wake({ agentId: a.id, ticketId: ta.id, reason: "assigned", priority: 2 });
    await ctx!.scheduler.wake({ agentId: b.id, ticketId: tb.id, reason: "assigned", priority: 2 });
    await ctx!.scheduler.tick();
    expect(ctx!.commands.map((c) => c.agentId)).toEqual([b.id]);
  });

  it("ages an agent-started wake like a scheduled one (DR-031; DR-002 left them flat)", async () => {
    ctx = await setup({ instance: 1, company: 1 });
    const a = await ctx!.agent("A");
    const b = await ctx!.agent("B");
    const old = await ctx!.scheduler.wake({ agentId: a.id, reason: "assigned", priority: 1 });
    await ctx!.scheduler.wake({ agentId: b.id, reason: "assigned", priority: 2 });
    await ctx!.db.update(wakes).set({ createdAt: new Date(Date.now() - 40 * 60_000) }).where(eq(wakes.id, old.id));
    await ctx!.scheduler.tick();
    expect(ctx!.commands.map((c) => c.agentId)).toEqual([a.id]);
  });
});

describe("wake classes: a held agent wake gains rank until it gets a slot (BOS-579)", () => {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const HOUR = 3_600_000;

  it("gives the next free slot to an 18-hour-old engagement wake ahead of newer scheduled wakes", async () => {
    // The stale-wake drop (BOS-1136) is turned off here: this test is about ranking by age.
    ctx = await setup({ instance: 1, company: 1, staleWakeMs: 1e12 });
    const busy = await ctx!.agent("Busy");
    const checker = await ctx!.agent("Checker");
    const watcher = await ctx!.agent("Watcher");
    const t1 = (await ctx!.req("POST", `/api/projects/${ctx!.project.id}/tickets`, { title: "Booked check" })).json();
    // The check belongs to the checker's own ticket: a "check due" wake on a parked ticket is dropped (BOS-1791).
    await ctx!.db.update(tickets).set({ assigneeAgentId: checker.id, systemState: "in_progress" }).where(eq(tickets.id, t1.id));
    // The one slot is taken, so everything below is held "at a concurrency limit".
    const [live] = await ctx!.db.insert(runs).values({ companyId: ctx!.company.id, agentId: busy.id, lastEventAt: new Date() }).returning();
    const engagement = await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "engagement", note: "Engagement 443477d4: the server is back." });
    const check = await ctx!.scheduler.notify(checker.id, { ticketId: t1.id, reason: "check due", note: "Check due (1 of 5)" });
    const watch = await ctx!.scheduler.wake({ agentId: watcher.id, reason: "missed work", note: "fresh" });
    await ctx!.db.update(wakes).set({ createdAt: ago(18 * HOUR) }).where(eq(wakes.id, engagement.id));
    // Newer than the engagement but old enough that, with only scheduled wakes ageing, it led by 4.
    await ctx!.db.update(wakes).set({ createdAt: ago(1 * HOUR) }).where(eq(wakes.id, check.id));
    await ctx!.scheduler.tick();
    expect(ctx!.commands).toHaveLength(0);
    expect((await ctx!.db.select().from(wakes).where(eq(wakes.id, engagement.id)))[0]!.statusReason).toBe(HELD_COMPANY);

    // The slot frees: the engagement goes first, and the scheduled wakes wait their turn.
    await ctx!.db.update(runs).set({ endedAt: new Date(), outcome: "end_turn" }).where(eq(runs.id, live!.id));
    await ctx!.scheduler.tick();
    expect(ctx!.commands.map((c) => c.agentId)).toEqual([ctx!.ceo.id]);
    const left = await ctx!.db.select().from(wakes).where(eq(wakes.status, "queued"));
    expect(left.map((w) => w.id).sort()).toEqual([check.id, watch.id].sort());
  });

  it("caps the age bonus: past it the oldest wake goes first, whatever its class or stored priority", async () => {
    // The stale-wake drop (BOS-1136) is turned off here: this test is about ranking by age.
    ctx = await setup({ instance: 1, company: 1, staleWakeMs: 1e12 });
    const a = await ctx!.agent("A");
    const b = await ctx!.agent("B");
    // 3 hours at priority 3 would be rank 15 without the cap, ahead of 18 hours at priority 2 (rank 10).
    const newer = await ctx!.scheduler.wake({ agentId: a.id, reason: "resume", priority: 3, note: "newer" });
    const older = await ctx!.scheduler.wake({ agentId: b.id, reason: "nudge", priority: 2, note: "older" });
    await ctx!.db.update(wakes).set({ createdAt: ago(3 * HOUR) }).where(eq(wakes.id, newer.id));
    await ctx!.db.update(wakes).set({ createdAt: ago(18 * HOUR) }).where(eq(wakes.id, older.id));
    await ctx!.scheduler.tick();
    expect(ctx!.commands.map((c) => c.agentId)).toEqual([b.id]);
  });

  it("still starts a someone-is-waiting wake ahead of any aged one", async () => {
    ctx = await setup({ instance: 1, company: 1 });
    const a = await ctx!.agent("A");
    const old = await ctx!.scheduler.wake({ agentId: a.id, reason: "engagement", note: "old" });
    await ctx!.db.update(wakes).set({ createdAt: ago(18 * HOUR) }).where(eq(wakes.id, old.id));
    await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "decision", note: "A card." });
    await ctx!.scheduler.tick();
    expect(ctx!.commands.map((c) => c.agentId)).toEqual([ctx!.ceo.id]);
  });
});

describe("wake classes: agedRank", () => {
  it("leaves waiting wakes alone, ages the others by 1 per 15 minutes, and stops at the cap", async () => {
    const { agedRank, AGE_RANK_CAP, AGE_STEP_MS } = await import("../src/services/wake-classes.js");
    expect(agedRank(2, "waiting", 10 * 3_600_000)).toBe(2);
    expect(agedRank(2, "agent", AGE_STEP_MS * 3)).toBe(5);
    expect(agedRank(2, "scheduled", AGE_STEP_MS * 3)).toBe(5);
    expect(agedRank(2, "agent", 18 * 3_600_000)).toBe(AGE_RANK_CAP);
    // A clock step backwards never lowers a rank, and a stored priority above the cap is kept.
    expect(agedRank(2, "agent", -60_000)).toBe(2);
    expect(agedRank(AGE_RANK_CAP + 2, "scheduled", 18 * 3_600_000)).toBe(AGE_RANK_CAP + 2);
  });
});

describe("wake classes: the reserved slot", () => {
  it("keeps one of the company's slots free for a card, and starts the card ahead of agent work", async () => {
    ctx = await setup({ instance: 8, company: 3, agent: 1 });
    const [a, b, c] = [await ctx!.agent("A"), await ctx!.agent("B"), await ctx!.agent("C")];
    for (const x of [a, b, c]) await ctx!.scheduler.wake({ agentId: x.id, reason: "assigned" });
    await ctx!.scheduler.tick();
    // Two work slots, not three: the third waits, so the CEO's card can start at once.
    expect(ctx!.commands).toHaveLength(2);
    await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "decision", priority: 2, note: "A card." });
    await ctx!.scheduler.tick();
    expect(ctx!.commands.map((x) => x.agentId)).toContain(ctx!.ceo.id);
  });
});

describe("wake classes: watch wakes", () => {
  it("carries the watched ticket's id for a single ticket, and never starts that ticket", async () => {
    ctx = await setup();
    const t = (await ctx!.req("POST", `/api/projects/${ctx!.project.id}/tickets`, { title: "Watched" })).json();
    await ctx!.req("PUT" as never, `/api/tickets/${t.id}/watcher`, { agentId: ctx!.ceo.id, everyMinutes: 30 });
    await ctx!.scheduler.slow();
    const [w] = await ctx!.db.select().from(wakes).where(eq(wakes.reason, "ticket watch"));
    expect(w).toMatchObject({ ticketId: t.id });
    expect((await ctx!.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).not.toBe("in_progress");
  });

  it("still launches a watch report on a ticket that is over its cost cap, and its cost is not counted against the cap", async () => {
    ctx = await setup();
    await ctx!.req("PATCH", `/api/projects/${ctx!.project.id}`, { ticketCostCapUsd: 1 });
    const t = (await ctx!.req("POST", `/api/projects/${ctx!.project.id}/tickets`, { title: "Watched" })).json();
    const worker = await ctx!.agent("Worker");
    // The worker's own ticket: an "assigned" wake on an unassigned parked ticket is dropped (BOS-1791).
    await ctx!.db.update(tickets).set({ assigneeAgentId: worker.id, systemState: "ready" }).where(eq(tickets.id, t.id));
    const fs = (await ctx!.req("POST" as never, "/api/funding-sources", { name: "API", kind: "api_payg", provider: "anthropic" })).json();
    const spend = async (origin: string | null, usd: number) => {
      const runId = randomUUID();
      await ctx!.db.insert(runs).values({ id: runId, companyId: ctx!.company.id, agentId: worker.id, ticketId: t.id, origin, endedAt: new Date() });
      await ctx!.db.insert(costEvents).values({ fundingSourceId: fs.id, companyId: ctx!.company.id, runId, costMicros: usd * 1e6 });
    };
    await spend("ticket watch", 5);
    await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, ticketId: t.id, reason: "ticket watch" });
    expect(await ctx!.scheduler.tick()).toMatchObject({ launched: 1, deferred: 0 });
    // Worker spend still counts: the same wake as agent work is held.
    await spend(null, 1.1);
    await ctx!.scheduler.wake({ agentId: worker.id, ticketId: t.id, reason: "assigned" });
    expect(await ctx!.scheduler.tick()).toMatchObject({ deferred: 1 });
  });
});

describe("wake classes: owner chats and steered notes", () => {
  it("lets an owner chat run alongside a full set of work slots' worth of work", async () => {
    ctx = await setup({ instance: 1, company: 1 });
    const worker = await ctx!.agent("Worker");
    // A chat run is open for the CEO; it must not take the one work slot.
    await ctx!.db.insert(runs).values({ companyId: ctx!.company.id, agentId: ctx!.ceo.id, purpose: "chat", origin: "owner_chat" });
    await ctx!.scheduler.wake({ agentId: worker.id, reason: "assigned" });
    await ctx!.scheduler.tick();
    expect(ctx!.commands.map((c) => c.agentId)).toEqual([worker.id]);
  });

  it("does not count a note steered into a live run against the no-ticket cap", async () => {
    ctx = await setup({ ticketlessPerHour: 2, agent: 5 });
    await ctx!.scheduler.wake({ agentId: ctx!.ceo.id, reason: "start" });
    await ctx!.scheduler.tick();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await ctx!.scheduler.notify(ctx!.ceo.id, { reason: "feedback", note: `note ${i}` }));
    expect(results.map((r) => r.outcome)).toEqual(["steered", "steered", "steered", "steered"]);
  });
});

describe("wake classes: callers of wake() and notify()", () => {
  // Every file that calls the scheduler's wake() or notify(), and what it does with a "dropped" result.
  // Only an agent-started wake is ever dropped, and wake() records the drop on the wake row and alerts
  // the owner itself, so a caller that must not lose the wake checks `outcome`; the rest need not.
  const CHECKS_OUTCOME = "checks the result";
  const NEVER_DROPPED = "only sends waiting or scheduled reasons, which are never dropped";
  const DROP_RECORDED = "an agent-started wake: a drop is on the wake row, and the owner is alerted once";
  const CALLERS: Record<string, string> = {
    "app.ts": DROP_RECORDED + " (assigned, feedback, skill decided); owner and rule wakes are never dropped",
    "routes/policy.ts": NEVER_DROPPED + " (the owner's rule request)",
    "routes/server-admin.ts": "the owner's wake-an-agent route: an owner wake is never dropped",
    "mcp.ts": DROP_RECORDED + " (hooks.wake: note request, ...)",
    "services/alert-ladder.ts": CHECKS_OUTCOME + " (a dropped rung is not counted as sent)",
    "services/check-dispatcher.ts": NEVER_DROPPED + " (check_result is scheduled)",
    "services/chat.ts": NEVER_DROPPED,
    "services/closed-notice.ts": NEVER_DROPPED + " (a flag note to an engaged owner, passed in as a dep)",
    "services/pa.ts": NEVER_DROPPED,
    "services/decisions.ts": NEVER_DROPPED + "; chased and engagement are " + DROP_RECORDED,
    "services/deploys.ts": NEVER_DROPPED,
    "services/engagements.ts": DROP_RECORDED,
    "services/progress.ts": NEVER_DROPPED + " (a status check steers into the live silent run)",
    "services/recovery.ts": NEVER_DROPPED,
    "services/main-ci.ts": CHECKS_OUTCOME + " (a dropped wake is skipped: the ticket is already open and the assignee finds it in its list)",
    "services/retro.ts": NEVER_DROPPED,
    "services/github-watch.ts": NEVER_DROPPED + " (github feedback and github security are scheduled)",
    "services/review.ts": DROP_RECORDED + " (ci passed is scheduled and never dropped)",
    "services/release-log.ts": CHECKS_OUTCOME + " (a dropped release wake is logged and retried next pass)",
    "services/review-kinds.ts": NEVER_DROPPED,
    "services/runs.ts": NEVER_DROPPED,
    "services/scheduler.ts": CHECKS_OUTCOME + " (check due retries next tick; nudge reports the drop)",
    "services/stale-requests.ts": CHECKS_OUTCOME + " (a dropped check is skipped)",
    "services/review-holds.ts": NEVER_DROPPED,
    "services/sweeps.ts": NEVER_DROPPED,
    "services/line-holder.ts": NEVER_DROPPED + " (line holder sent back and line holder stuck are waiting reasons)",
    "services/owner-replies.ts": CHECKS_OUTCOME + " (a dropped re-wake still counts as the one try; the 10-minute ask does not need it to land)",
    "services/ticket-chat.ts": NEVER_DROPPED,
    "services/merge-stall.ts": NEVER_DROPPED + " (merge line stalled is a waiting reason; deps.notify is the owner's notification, not a wake)",
    "services/watchdog.ts": CHECKS_OUTCOME + " (a dropped wake is reported, not counted as sent)",
  };

  it("lists every file that wakes an agent, so a new caller has to say how it handles a drop", () => {
    const callers = walk(SRC)
      .filter((f) => /\b(scheduler|deps|self|this)\.(wake|notify)\(|\bwake\(\{|\.setWakeHook\(|\bnotify: \(agentId/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f))
      // These call a notes notifier of the same name, which tells the owner and wakes nobody.
      .filter((f) => f !== "services/maintenance.ts" && f !== "services/self-deploy.ts" && f !== "services/runner-watch.ts" && f !== "services/deploy-wait.ts" && f !== "services/merge-jam.ts");
    const unlisted = callers.filter((f) => !(f in CALLERS));
    expect(unlisted).toEqual([]);
  });
});
