// BOS-2765: heldReadyTickets (agent-wip.ts): the Ready tickets a WIP limit has refused, each with the limit that
// refuses it now. Tested against the in-memory database with rows inserted straight into the tables, as
// test/check-hold.test.ts does (no buildApp). Without buildApp no start-hold counts source is registered, so
// queueStartHold holds nothing and is left to the default limit rules here.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, companies, projects, settings, tickets } from "../src/db/schema.js";
import { heldReadyTickets } from "../src/services/agent-wip.js";

let ctx: Awaited<ReturnType<typeof setup>>;

beforeEach(async () => {
  ctx = await setup();
});

afterEach(async () => {
  await ctx.close();
});

async function setup() {
  const { db, close } = await openPglite();
  let n = 0;
  const company = async (name: string) => (await db.insert(companies).values({ name: `${name} ${++n}` }).returning())[0]!;
  const co = await company("Co");
  const [p] = await db.insert(projects).values({ companyId: co.id, name: "Dev" }).returning();
  const agent = async (name: string, companyId = co.id) =>
    (await db.insert(agents).values({ companyId, name, role: "worker", agentKind: "claude" } as never).returning())[0]!;
  const worker = await agent("Worker");
  let ticketNumber = 0;
  const ticket = async (state: typeof tickets.$inferInsert["systemState"], patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co.id, projectId: p!.id, title: "T", number: ++ticketNumber, assigneeAgentId: worker.id, systemState: state, ...patch } as never).returning())[0]!;
  const setLimits = async (value: unknown) => db.insert(settings).values({ key: "wip_limits", value } as never);
  return { db, close, co, project: p!.id, worker, agent, company, ticket, setLimits };
}

describe("heldReadyTickets", () => {
  it("lists only this company's Ready tickets with wipHeldAt set", async () => {
    const { db, co, agent, company, ticket } = ctx;
    const held = await ticket("ready", { wipHeldAt: new Date() });
    await ticket("ready");
    await ticket("in_progress", { wipHeldAt: new Date() });
    const other = await company("Other Co");
    const [otherProject] = await db.insert(projects).values({ companyId: other.id, name: "Dev" }).returning();
    const otherWorker = await agent("Other worker", other.id);
    await db.insert(tickets).values({ companyId: other.id, projectId: otherProject!.id, title: "T", number: 99, assigneeAgentId: otherWorker.id, systemState: "ready", wipHeldAt: new Date() } as never);

    const rows = await heldReadyTickets(db, co.id);
    expect(rows.map((r) => r.ticket.id)).toEqual([held.id]);
    expect(rows[0]!.scope).toBeNull();
  });

  it("names the agent limit while its assignee is at the limit, and no limit once that ticket is done", async () => {
    const { db, co, ticket, setLimits } = ctx;
    await setLimits({ agent: 1 });
    const busy = await ticket("in_progress");
    await ticket("ready", { wipHeldAt: new Date() });

    expect((await heldReadyTickets(db, co.id))[0]!.scope).toBe("agent");

    await db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, busy.id));
    expect((await heldReadyTickets(db, co.id))[0]!.scope).toBeNull();
  });
});
