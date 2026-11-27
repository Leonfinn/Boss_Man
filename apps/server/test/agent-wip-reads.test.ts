// BOS-2750: the small database-backed reads behind the WIP limit (agent-wip.ts): countWip, wasStarted and
// startHoldExempt. Tested against the in-memory database with rows inserted straight into the tables, as
// test/check-hold.test.ts does (no buildApp).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { activity, agents, companies, projects, tickets } from "../src/db/schema.js";
import { countWip, startHoldExempt, wasStarted } from "../src/services/agent-wip.js";

let ctx: Awaited<ReturnType<typeof setup>>;

beforeEach(async () => {
  ctx = await setup();
});

afterEach(async () => {
  await ctx.close();
});

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const agent = async (role: "ceo" | "manager" | "worker", name: string) => (await db.insert(agents).values({ companyId: co!.id, name, role, agentKind: "claude" } as never).returning())[0]!;
  const worker = await agent("worker", "Worker");
  let n = 0;
  const ticket = async (state: typeof tickets.$inferInsert["systemState"], patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, assigneeAgentId: worker.id, systemState: state, ...patch } as never).returning())[0]!;
  const note = async (ticketId: string, kind: string, summary: string) => db.insert(activity).values({ companyId: co!.id, ticketId, kind, summary });
  return { db, close, company: co!.id, project: p!.id, worker, agent, ticket, note };
}

describe("countWip", () => {
  it("counts the tickets matching a where, and leaves one out with exceptId", async () => {
    const { db, ticket } = ctx;
    const first = await ticket("in_progress");
    await ticket("in_progress");
    await ticket("ready");
    const inProgress = eq(tickets.systemState, "in_progress");
    expect(await countWip(db, inProgress)).toBe(2);
    expect(await countWip(db, inProgress, first.id)).toBe(1);
  });

  it("counts every ticket when where is undefined, and none when nothing matches", async () => {
    const { db, ticket } = ctx;
    await ticket("in_progress");
    await ticket("ready");
    await ticket("review");
    expect(await countWip(db, undefined)).toBe(3);
    expect(await countWip(db, eq(tickets.systemState, "blocked"))).toBe(0);
  });
});

describe("wasStarted", () => {
  it("is true for a state row whose summary contains ' -> in_progress'", async () => {
    const { db, ticket, note } = ctx;
    const t = await ticket("ready");
    await note(t.id, "state", "ready -> in_progress: Boss Man: started on the wake");
    expect(await wasStarted(db, t.id)).toBe(true);
  });

  it("is false with only ready or review state rows", async () => {
    const { db, ticket, note } = ctx;
    const t = await ticket("backlog");
    await note(t.id, "state", "backlog -> ready: assigned");
    await note(t.id, "state", "ready -> review: handed in");
    expect(await wasStarted(db, t.id)).toBe(false);
  });

  it("ignores a matching summary under another activity kind", async () => {
    const { db, ticket, note } = ctx;
    const t = await ticket("ready");
    await note(t.id, "message", "ready -> in_progress: said so in a message");
    expect(await wasStarted(db, t.id)).toBe(false);
  });

  it("ignores a matching row on another ticket", async () => {
    const { db, ticket, note } = ctx;
    const other = await ticket("ready");
    const t = await ticket("ready");
    await note(other.id, "state", "ready -> in_progress: started");
    expect(await wasStarted(db, t.id)).toBe(false);
  });
});

describe("startHoldExempt", () => {
  it("passes an urgent ticket and one that fixes a live problem", async () => {
    const { db, worker } = ctx;
    expect(await startHoldExempt(db, { urgent: true, fixesLive: null, assigneeAgentId: worker.id })).toBe(true);
    expect(await startHoldExempt(db, { urgent: false, fixesLive: "server freezes", assigneeAgentId: worker.id })).toBe(true);
  });

  it("does not pass blank fixesLive text, and needs no assignee", async () => {
    const { db } = ctx;
    expect(await startHoldExempt(db, { urgent: false, fixesLive: "   ", assigneeAgentId: null })).toBe(false);
    expect(await startHoldExempt(db, { urgent: false, fixesLive: null, assigneeAgentId: null })).toBe(false);
  });

  it("passes a ticket assigned to the CEO and not one assigned to anyone else", async () => {
    const { db, worker, agent } = ctx;
    const ceo = await agent("ceo", "The CEO");
    const manager = await agent("manager", "A manager");
    expect(await startHoldExempt(db, { urgent: false, fixesLive: null, assigneeAgentId: ceo.id })).toBe(true);
    expect(await startHoldExempt(db, { urgent: false, fixesLive: null, assigneeAgentId: worker.id })).toBe(false);
    expect(await startHoldExempt(db, { urgent: false, fixesLive: null, assigneeAgentId: manager.id })).toBe(false);
  });

  it("does not pass an assignee id with no agent row", async () => {
    const { db } = ctx;
    expect(await startHoldExempt(db, { urgent: false, fixesLive: null, assigneeAgentId: "00000000-0000-0000-0000-000000000000" })).toBe(false);
  });
});
