// BOS-2911: the board's card for a Ready ticket whose assignee is at their in-progress limit names the tickets it is queued behind.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { settings, tickets, wakes } from "../src/db/schema.js";

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
  const number = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!.number;
  const board = async () => ((await req("GET", `/api/projects/${project.id}/board`)).json() as { columns: { tickets: { id: string; queuedBehind?: string[] | null }[] }[] }).columns.flatMap((c) => c.tickets);
  const setLimits = (v: { agent: number | null }) => db.insert(settings).values({ key: "wip_limits", value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
  return { ...built, db, close, ticket, number, board, setLimits };
}

describe("a Ready ticket at its assignee's limit names what it waits behind (BOS-2911)", () => {
  it("lists the in-progress tickets that fill the limit, and nothing once there is room or the ticket is not Ready", async () => {
    const c = (ctx = await setup());
    await c.setLimits({ agent: 2 });
    const a = await c.ticket("in_progress");
    const b = await c.ticket("in_progress");
    const waiting = await c.ticket("ready");
    const cards = await c.board();
    expect(cards.find((x) => x.id === waiting.id)?.queuedBehind).toEqual([`APP-${await c.number(a.id)}`, `APP-${await c.number(b.id)}`]);
    // Tickets that are not Ready carry no line.
    expect(cards.find((x) => x.id === a.id)?.queuedBehind ?? null).toBeNull();

    // One finishes: under the limit, so nothing is queued.
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, a.id));
    expect((await c.board()).find((x) => x.id === waiting.id)?.queuedBehind ?? null).toBeNull();
  });

  it("with no limit set, no ticket is queued behind anything", async () => {
    const c = (ctx = await setup());
    await c.setLimits({ agent: null });
    await c.ticket("in_progress");
    await c.ticket("in_progress");
    const waiting = await c.ticket("ready");
    expect((await c.board()).find((x) => x.id === waiting.id)?.queuedBehind ?? null).toBeNull();
  });
});
