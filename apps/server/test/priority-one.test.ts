// BOS-1516: the owner's "Priority 1" switch on a ticket and on a feature, the "Ready to put live" mark that pages once when the
// whole group has merged, and the place a Priority 1 ticket keeps after a send-back.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, companies, features, ticketDependencies, tickets } from "../src/db/schema.js";
import { readyUrgentFor, priorityGroup } from "../src/services/priority-group.js";
import { checkQueue } from "../src/services/check-queue.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  await db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co.company.id));
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  let n = 100;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: `Work ${n}`, number: n++, systemState: "in_progress", ...patch }).returning())[0]!;
  const feature = async () => (await db.insert(features).values({ companyId: co.company.id, title: "Big feature" }).returning())[0]!;
  return { ...built, db, close, req, co, project, ticket, feature };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const row = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

describe("Priority 1 on a ticket", () => {
  it("the owner's urgent switch records that the owner set it, and turning it off clears both", async () => {
    const t = await ctx.ticket();
    expect((await ctx.req("PATCH", `/api/tickets/${t.id}`, { urgent: true })).statusCode).toBe(200);
    expect(await row(t.id)).toMatchObject({ urgent: true, urgentByOwner: true });
    await ctx.req("PATCH", `/api/tickets/${t.id}`, { urgent: false });
    expect(await row(t.id)).toMatchObject({ urgent: false, urgentByOwner: false });
  });
});

describe("Priority 1 on a feature", () => {
  it("marks its open tickets, leaves done ones, and turning it off clears the marks it set", async () => {
    const f = await ctx.feature();
    const open = await ctx.ticket({ featureId: f.id });
    const done = await ctx.ticket({ featureId: f.id, systemState: "done" });
    const ceoMark = await ctx.ticket({ featureId: f.id, urgent: true });
    const on = await ctx.req("PUT", `/api/features/${f.id}/priority-one`, { on: true });
    expect(on.json()).toMatchObject({ priorityOne: true, tickets: 2 });
    expect(await row(open.id)).toMatchObject({ urgent: true, urgentByOwner: true });
    expect((await ctx.req("GET", `/api/features/${f.id}`)).json()).toMatchObject({ feature: { priorityOne: true } });
    expect(await row(done.id)).toMatchObject({ urgent: false, urgentByOwner: false });
    await ctx.req("PUT", `/api/features/${f.id}/priority-one`, { on: false });
    expect(await row(open.id)).toMatchObject({ urgent: false, urgentByOwner: false });
    // The owner's switch takes over a mark the CEO had set, so switching it off clears that one too.
    expect(await row(ceoMark.id)).toMatchObject({ urgent: false, urgentByOwner: false });
  });
});

describe("Ready to put live (one page for a group)", () => {
  it("a lone Priority 1 ticket that merged is ready; a CEO-only urgent mark is not", async () => {
    const mine = await ctx.ticket({ urgent: true, urgentByOwner: true, systemState: "done", mergeCommit: "a".repeat(40) });
    const ceo = await ctx.ticket({ urgent: true, systemState: "done", mergeCommit: "b".repeat(40) });
    const r = await readyUrgentFor(ctx.db, mine.id);
    expect(r).toMatchObject({ kind: "ready" });
    expect(r!.heading).toMatch(/^Ready to put live: Work \d+ \(BOS-\d+\)$/);
    expect(await readyUrgentFor(ctx.db, ceo.id)).toBeUndefined();
  });

  it("pages only when the last member of a parent / waits-on group has merged", async () => {
    const parent = await ctx.ticket({ urgent: true, urgentByOwner: true, systemState: "done", mergeCommit: "a".repeat(40) });
    const child = await ctx.ticket({ urgent: true, urgentByOwner: true, parentTicketId: parent.id });
    const waits = await ctx.ticket({ urgent: true, urgentByOwner: true });
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: child.id, blockerTicketId: waits.id });
    expect((await priorityGroup(ctx.db, parent.id)).map((m) => m.id).sort()).toEqual([parent.id, child.id, waits.id].sort());
    expect(await readyUrgentFor(ctx.db, parent.id)).toBeUndefined();
    await ctx.db.update(tickets).set({ systemState: "done", mergeCommit: "c".repeat(40) }).where(eq(tickets.id, child.id));
    expect(await readyUrgentFor(ctx.db, parent.id)).toBeUndefined(); // one more still open
    await ctx.db.update(tickets).set({ systemState: "done", mergeCommit: "d".repeat(40) }).where(eq(tickets.id, waits.id));
    expect(await readyUrgentFor(ctx.db, parent.id)).toMatchObject({ kind: "ready" });
  });
});

describe("Priority 1 keeps its place after a send-back", () => {
  it("an earlier failed merge job still lends its place to a Priority 1 ticket, not to an ordinary one", async () => {
    const q = checkQueue(ctx.db);
    const early = new Date(Date.now() - 3 * 3_600_000);
    const mk = async (ticketId: string) =>
      ctx.db.insert(checkJobs).values({ companyId: ctx.co.company.id, projectId: ctx.project.id, ticketId, kind: "merge", scope: "full", commit: "a".repeat(40), tree: `t-${ticketId}`, state: "failed", queuedAt: early, endedAt: early }).returning();
    const p1 = await ctx.ticket({ urgent: true, urgentByOwner: true, systemState: "review" });
    const plain = await ctx.ticket({ systemState: "review" });
    await mk(p1.id);
    await mk(plain.id);
    expect((await q.place(p1.id)).at?.getTime()).toBe(early.getTime());
    expect((await q.place(plain.id)).at).toBeNull();
  });
});
