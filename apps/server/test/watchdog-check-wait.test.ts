import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WATCHDOG } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { evaluate } from "../src/services/watchdog-rules.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, runs, tickets } from "../src/db/schema.js";

// BOS-1760: the watchdog's snapshot reads what an in-progress ticket waits on from the check queue, so the
// "in progress with no run" rules stay quiet while its quick check or merge is queued or running.

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const clock = new Date();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws", now: () => clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload: unknown) => built.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Developer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${companyId}/projects`, { name: "Site" })).json() as { id: string };
  const ago = (minutes: number) => new Date(clock.getTime() - minutes * 60_000);
  const ticket = async (title: string) =>
    (await db.insert(tickets).values({ companyId, projectId: project.id, title, systemState: "in_progress", assigneeAgentId: dev.id, stateChangedAt: ago(300) }).returning())[0]!;
  const job = (ticketId: string, v: { kind?: string; commit?: string; state: string; queuedAt: Date; endedAt?: Date }) =>
    db.insert(checkJobs).values({ companyId, projectId: project.id, ticketId, kind: v.kind ?? "pre_review", scope: "quick", commit: v.commit ?? "aaa", tree: "t", state: v.state, queuedAt: v.queuedAt, endedAt: v.endedAt ?? null });
  // The agent asked for its check and ended its run 290 minutes ago.
  const asked = (ticketId: string) => db.insert(runs).values({ companyId, agentId: dev.id, ticketId, purpose: "work", startedAt: ago(299), endedAt: ago(290), outcome: "end_turn" });
  return { ...built, db, close, companyId, ago, ticket, job, asked };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

describe("watchdog snapshot: waits in the check queue (BOS-1760)", () => {
  it("keeps live checks and merges, and only the newest head's quick checks", async () => {
    const queued = await ctx.ticket("Quick check queued 40 deep");
    await ctx.asked(queued.id);
    await ctx.job(queued.id, { state: "queued", queuedAt: ctx.ago(291) });
    const merging = await ctx.ticket("Merge running");
    await ctx.asked(merging.id);
    await ctx.job(merging.id, { kind: "merge", state: "running", queuedAt: ctx.ago(291) });
    // A check on an old head is still running, but the agent has since committed and its newer check passed: no wait.
    const moved = await ctx.ticket("Old head's check");
    await ctx.asked(moved.id);
    await ctx.job(moved.id, { commit: "old", state: "running", queuedAt: ctx.ago(295) });
    await ctx.job(moved.id, { commit: "new", state: "passed", queuedAt: ctx.ago(291), endedAt: ctx.ago(200) });
    // A check that ended before the ticket last moved isn't read at all.
    const before = await ctx.ticket("Old check");
    await ctx.asked(before.id);
    await ctx.job(before.id, { state: "passed", queuedAt: ctx.ago(500), endedAt: ctx.ago(400) });
    // Nothing in the queue: the same shape is flagged as before.
    const idle = await ctx.ticket("No check");
    await ctx.asked(idle.id);

    const snap = await ctx.watchdog.snapshot(ctx.companyId);
    const by = new Map(snap.tickets.map((t) => [t.id, t.checks]));
    expect(by.get(queued.id)).toEqual([{ from: ctx.ago(291), to: null }]);
    expect(by.get(merging.id)).toEqual([{ from: ctx.ago(291), to: null }]);
    expect(by.get(moved.id)).toEqual([{ from: ctx.ago(291), to: ctx.ago(200) }]);
    expect(by.get(before.id)).toBeUndefined();
    expect(by.get(idle.id)).toBeUndefined();

    const flagged = evaluate(snap, { ...DEFAULT_WATCHDOG, enabled: true }, ctx.ago(0)).map((x) => x.ticketId);
    expect(flagged).not.toContain(queued.id);
    expect(flagged).not.toContain(merging.id);
    expect(flagged).toContain(moved.id);
    expect(flagged).toContain(before.id);
    expect(flagged).toContain(idle.id);
  });
});
