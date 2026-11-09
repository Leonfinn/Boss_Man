import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, projects, tickets } from "../src/db/schema.js";
import { addTicketDependency } from "../src/services/ticket-links.js";
import { systemMoveTicket } from "../src/services/ticket-transition.js";

// BOS-898: the system's own moves (blocker finished -> ready, held by a dependency -> blocked) leave a
// `state` activity row with the reason, like every other move.
let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string }; ceo: { id: string } };
  const [p] = await db.insert(projects).values({ companyId: co.company.id, name: "Customer app" }).returning();
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: p!.id, title: "T", systemState: "ready", ...patch }).returning())[0]!;
  return { ...built, db, close, co, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const stateRows = async (ticketId: string) => (await ctx.db.select().from(activity).where(and(eq(activity.ticketId, ticketId), eq(activity.kind, "state")))).map((r) => r.summary);

describe("system ticket moves are recorded", () => {
  it("systemMoveTicket moves a guarded ticket and records the reason; a failed guard records nothing", async () => {
    const t = await ctx.ticket({ systemState: "blocked" });
    expect(await systemMoveTicket(ctx.db, { ticketId: t.id, from: ["backlog"], to: "ready", reason: "x", now: new Date() })).toBeNull();
    expect(await stateRows(t.id)).toEqual([]);
    await systemMoveTicket(ctx.db, { ticketId: t.id, from: ["blocked"], to: "ready", reason: "what it waited on finished", now: new Date() });
    expect(await stateRows(t.id)).toEqual(["blocked -> ready: what it waited on finished"]);
  });

  it("a finished blocker releases the dependent and the history says so", async () => {
    const blocker = await ctx.ticket({ systemState: "in_progress" });
    const dependent = await ctx.ticket({ systemState: "ready", assigneeAgentId: ctx.co.ceo.id });
    await addTicketDependency(ctx.db, { companyId: ctx.co.company.id, blockedTicketId: dependent.id, blockerTicketId: blocker.id, actor: { type: "system" }, hold: true });
    expect(await stateRows(dependent.id)).toEqual(["ready -> blocked: held by a ticket it depends on"]);
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, blocker.id));
    await ctx.scheduler.onTicketDone(blocker.id);
    expect((await stateRows(dependent.id)).at(-1)).toBe("blocked -> ready: what it waited on finished");
  });
});
