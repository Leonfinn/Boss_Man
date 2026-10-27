import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { notifications, tickets, watchdogActions, watchdogFlags } from "../src/db/schema.js";
import { buildSummary } from "../src/services/watchdog-summary.js";

const H = 3_600_000;
const now = new Date("2026-10-27T09:00:00Z");
const base = { now, caught: 0, fixed: 0, actions: {}, open: [], decisions: [] };

describe("the daily summary text (BOS-60)", () => {
  it("says nothing on a day nothing happened, even with old problems still open", () => {
    const stale = [{ ref: "BOS-1", title: "Old", rule: "stale_review" as const, waitingOn: "Dev", openedAt: new Date(now.getTime() - 50 * H) }];
    expect(buildSummary({ ...base, open: stale })).toBeNull();
    // Sweep wakes and reminders alone aren't "something happened" to the owner.
    expect(buildSummary({ ...base, actions: { sweep_wake: 3, owner_reminder: 1 } })).toBeNull();
  });

  it("gives counts, who each open problem waits on, decisions with their age, and one headline with the oldest", () => {
    const s = buildSummary({
      ...base,
      caught: 3,
      fixed: 2,
      actions: { nudge: 2, snooze: 1 },
      open: [
        { ref: "BOS-7", title: "Fix login", rule: "stale_in_progress", waitingOn: "Developer", openedAt: new Date(now.getTime() - 5 * H) },
        { ref: "BOS-3", title: "Old thing", rule: "unassigned", waitingOn: "nobody (unassigned)", openedAt: new Date(now.getTime() - 30 * H) },
        { ref: "BOS-9", title: "Needs you", rule: "owner_decision_waiting", waitingOn: "you", openedAt: new Date(now.getTime() - 40 * H) },
      ],
      decisions: [{ question: "Pick a host", blocks: ["BOS-9"], askedAt: new Date(now.getTime() - 3 * H) }],
    })!;
    expect(s.stuck).toBe(2);
    expect(s.oldestRef).toBe("BOS-3");
    expect(s.body).toContain("2 tickets are stuck past the limit; the oldest is BOS-3, for 30 hours.");
    expect(s.body).toContain("Caught 3 problems; 2 cleared since.");
    expect(s.body).toContain("2 nudged, 1 snoozed");
    expect(s.body).toContain("BOS-7");
    expect(s.body).toContain("waiting on Developer");
    expect(s.body).toContain('"Pick a host" holds BOS-9; asked 3 hours ago');
  });
});

let ctx: Awaited<ReturnType<typeof setup>>;
async function setup() {
  let clock = new Date("2026-10-27T09:00:00Z");
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const project = (await req("POST", `/api/companies/${companyId}/projects`, { name: "Site" })).json() as { id: string };
  const ticket = async (title: string, patch: Partial<typeof tickets.$inferInsert> = {}) => (await db.insert(tickets).values({ companyId, projectId: project.id, title, systemState: "in_progress", ...patch }).returning())[0]!;
  const pages = () => db.select().from(notifications).where(eq(notifications.level, "page"));
  return { ...built, db, close, companyId, ticket, pages, advance: (h: number) => (clock = new Date(clock.getTime() + h * H)) };
}
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

describe("urgent interrupts (BOS-60)", () => {
  // Through the real paths: raise a decision on A, then make other tickets wait on A.
  const raiseOn = async (t: { id: string }) => ctx.decisions.raise({ companyId: ctx.companyId, agentId: null, question: "Which host?", options: ["A", "B"], recommended: "A", blocksTicketId: t.id });
  const waitOn = async (t: { id: string }, holder: { id: string }) => ctx.work.addDependency(t.id, { ticketId: holder.id });

  it("pages once when one owner decision holds three tickets through the chain, and not for two", async () => {
    const a = await ctx.ticket("A", { systemState: "blocked" });
    const b = await ctx.ticket("B", { systemState: "blocked" });
    const c = await ctx.ticket("C", { systemState: "blocked" });
    await raiseOn(a);
    await waitOn(b, a);
    await ctx.watchdog.urgentCheck(ctx.companyId);
    expect(await ctx.pages()).toHaveLength(0);
    await waitOn(c, b); // two hops from the decision
    await ctx.watchdog.urgentCheck(ctx.companyId);
    await ctx.watchdog.urgentCheck(ctx.companyId);
    const pages = await ctx.pages();
    expect(pages).toHaveLength(1);
    expect(pages[0]!.title).toContain("3 tickets");
    expect(await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "urgent_alert"))).toHaveLength(1);
  });

  it("does not count finished tickets", async () => {
    const a = await ctx.ticket("A", { systemState: "blocked" });
    const b = await ctx.ticket("B", { systemState: "blocked" });
    const c = await ctx.ticket("C", { systemState: "done" });
    await raiseOn(a);
    await waitOn(b, a);
    await waitOn(c, a);
    await ctx.watchdog.urgentCheck(ctx.companyId);
    expect(await ctx.pages()).toHaveLength(0);
  });
});

describe("the daily summary send (BOS-60)", () => {
  const notes = () => ctx.db.select().from(notifications).where(eq(notifications.title, "Scrum Master daily summary"));

  it("sends nothing on a quiet day, one summary when something happened, and not twice in a day", async () => {
    expect(await ctx.watchdog.dailySummary(ctx.companyId)).toBe(false);
    const t = await ctx.ticket("Stuck", { assigneeAgentId: null });
    await ctx.db.insert(watchdogFlags).values({ companyId: ctx.companyId, ticketId: t.id, rule: "unassigned", openedAt: new Date("2026-10-27T08:30:00Z") });
    expect(await ctx.watchdog.dailySummary(ctx.companyId)).toBe(true);
    expect((await notes())[0]!.body).toContain("nobody (unassigned)");
    expect(await ctx.watchdog.dailySummary(ctx.companyId)).toBe(false);
    expect(await notes()).toHaveLength(1);
    // The next day, with nothing new, stays quiet again.
    ctx.advance(24);
    expect(await ctx.watchdog.dailySummary(ctx.companyId)).toBe(false);
    expect(await notes()).toHaveLength(1);
  });

  it("does not send before 8 in the morning", async () => {
    const t = await ctx.ticket("Stuck");
    await ctx.db.insert(watchdogFlags).values({ companyId: ctx.companyId, ticketId: t.id, rule: "unassigned", openedAt: new Date("2026-10-27T08:30:00Z") });
    ctx.advance(-3); // 06:00 UTC
    expect(await ctx.watchdog.dailySummary(ctx.companyId)).toBe(false);
  });
});
