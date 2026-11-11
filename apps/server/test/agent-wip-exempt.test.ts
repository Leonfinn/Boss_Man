// BOS-1172: in-progress tickets that can't move (open waits-on link, plan waiting on the owner, merged and waiting to
// go live) don't count towards the WIP limit; one with only a booked check still counts. The board says why.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { agentWipCount, countInProgress } from "../src/services/agent-wip.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "GET", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const ticket = async (state: typeof tickets.$inferInsert["systemState"], patch: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${randomUUID().slice(0, 4)}`, assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: state, ...patch }).where(eq(tickets.id, t.id));
    await db.delete(wakes).where(eq(wakes.ticketId, t.id));
    return t;
  };
  const board = async () => ((await req("GET", `/api/projects/${project.id}/board`)).json() as { columns: { tickets: { id: string; wipExempt?: string | null }[] }[] }).columns.flatMap((c) => c.tickets);
  return { ...built, db, close, company, worker, ticket, board };
}

describe("tickets that can't move don't count towards the WIP limit", () => {
  it("an open waits-on link stops counting until the blocker is done; a plain in-progress ticket and a booked check still count", async () => {
    ctx = await setup();
    const c = ctx;
    const plain = await c.ticket("in_progress");
    const blocker = await c.ticket("in_progress");
    const waiting = await c.ticket("in_progress");
    await c.db.insert(ticketDependencies).values({ blockedTicketId: waiting.id, blockerTicketId: blocker.id, until: "done" });
    const booked = await c.ticket("in_progress", { monitorAt: new Date(Date.now() + 3_600_000), monitorNote: "check CI" });
    expect(await agentWipCount(c.db, c.worker.id)).toBe(3); // plain, blocker, booked
    expect((await c.board()).find((t) => t.id === waiting.id)?.wipExempt).toBe("waits");
    expect((await c.board()).find((t) => t.id === booked.id)?.wipExempt ?? null).toBeNull();
    await c.db.update(tickets).set({ systemState: "done", outcome: "completed" }).where(eq(tickets.id, blocker.id));
    expect(await agentWipCount(c.db, c.worker.id)).toBe(3); // plain, waiting (wait over), booked
    expect((await c.board()).find((t) => t.id === waiting.id)?.wipExempt ?? null).toBeNull();
    expect(plain.id).toBeTruthy();
  });

  it("a `merged` link ends when the blocker has a merge commit", async () => {
    ctx = await setup();
    const c = ctx;
    const blocker = await c.ticket("review");
    const waiting = await c.ticket("in_progress");
    await c.db.insert(ticketDependencies).values({ blockedTicketId: waiting.id, blockerTicketId: blocker.id, until: "merged" });
    expect(await agentWipCount(c.db, c.worker.id)).toBe(0);
    await c.db.update(tickets).set({ mergeCommit: "abc123" }).where(eq(tickets.id, blocker.id));
    expect(await agentWipCount(c.db, c.worker.id)).toBe(1);
  });

  it("a plan waiting on the owner doesn't count; an unapproved ticket still being planned does", async () => {
    ctx = await setup();
    const c = ctx;
    const planned = await c.ticket("in_progress", { planFirst: true, plan: "The plan" });
    const planning = await c.ticket("in_progress", { planFirst: true });
    expect(await agentWipCount(c.db, c.worker.id)).toBe(1);
    expect((await c.board()).find((t) => t.id === planned.id)?.wipExempt).toBe("plan");
    await c.db.update(tickets).set({ planApprovedAt: new Date() }).where(eq(tickets.id, planned.id));
    expect(await agentWipCount(c.db, c.worker.id)).toBe(2);
    expect(planning.id).toBeTruthy();
  });

  it("a merged ticket waiting for its go-live check doesn't count, company-wide too", async () => {
    ctx = await setup();
    const c = ctx;
    const live = await c.ticket("in_progress", { mergedAt: new Date(), goLiveWait: "server" });
    await c.ticket("in_progress");
    expect(await agentWipCount(c.db, c.worker.id)).toBe(1);
    expect(await countInProgress(c.db, eq(tickets.companyId, c.company.id))).toBe(1);
    expect((await c.board()).find((t) => t.id === live.id)?.wipExempt).toBe("live");
  });
});
