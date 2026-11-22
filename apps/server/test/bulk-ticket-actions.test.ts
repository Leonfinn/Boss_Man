import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, tickets } from "../src/db/schema.js";

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
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const ticket = async (extra: object = {}) => (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Docs", ...extra })).json() as { id: string };
  const bulk = (ids: string[], action: object) => req("POST", "/api/tickets/bulk", { ids, action });
  return { ...built, db, close, req, worker, ticket, bulk };
}

describe("bulk ticket actions", () => {
  it("moves several tickets to Blocked, each with its own history line", async () => {
    const c = (ctx = await setup());
    const ids = [(await c.ticket()).id, (await c.ticket()).id, (await c.ticket()).id];
    const r = await c.bulk(ids, { type: "move", state: "blocked" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { done: { id: string }[]; refused: unknown[] };
    expect(body.done.map((d) => d.id).sort()).toEqual([...ids].sort());
    expect(body.refused).toEqual([]);
    for (const id of ids) {
      const [t] = await c.db.select().from(tickets).where(eq(tickets.id, id));
      expect(t!.systemState).toBe("blocked");
      const lines = await c.db.select().from(activity).where(eq(activity.ticketId, id));
      expect(lines.some((l) => /Owner moved it to Blocked/.test(l.summary))).toBe(true);
    }
  });

  it("moves 5 tickets to Backlog with the same history line a single move gives", async () => {
    const c = (ctx = await setup());
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await c.ticket()).id);
    const body = (await c.bulk(ids, { type: "move", state: "backlog" })).json() as { done: unknown[]; refused: unknown[] };
    expect(body.done).toHaveLength(5);
    const single = await c.ticket();
    await c.req("POST", `/api/tickets/${single.id}/state`, { state: "backlog" });
    const lineOf = async (id: string) => (await c.db.select().from(activity).where(eq(activity.ticketId, id))).map((l) => l.summary).filter((s) => /moved it to Backlog/.test(s));
    for (const id of ids) expect(await lineOf(id)).toEqual(await lineOf(single.id));
  });

  it("a signed-out request is refused and changes nothing", async () => {
    const c = (ctx = await setup());
    const a = await c.ticket();
    const r = await c.app.inject({ method: "POST", url: "/api/tickets/bulk", payload: { ids: [a.id], action: { type: "move", state: "blocked" } } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, a.id)))[0]!.systemState).not.toBe("blocked");
  });

  it("refuses an agent of another company for 2 tickets and leaves them unchanged", async () => {
    const c = (ctx = await setup());
    const other = (await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    const foreign = (await c.req("POST", `/api/companies/${other.company.id}/agents`, { name: "Stranger" })).json() as { id: string };
    const a = await c.ticket();
    const b = await c.ticket();
    const body = (await c.bulk([a.id, b.id], { type: "assign", assigneeAgentId: foreign.id })).json() as { done: unknown[]; refused: { id: string; reason: string }[] };
    expect(body.done).toEqual([]);
    expect(body.refused.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(body.refused.every((x) => x.reason.length > 0)).toBe(true);
    for (const id of [a.id, b.id]) expect((await c.db.select().from(tickets).where(eq(tickets.id, id)))[0]!.assigneeAgentId).toBeNull();
  });

  it("refuses an unknown ticket for that ticket only", async () => {
    const c = (ctx = await setup());
    const a = await c.ticket();
    const ghost = randomUUID();
    const r = await c.bulk([a.id, ghost], { type: "move", state: "backlog" });
    const body = r.json() as { done: { id: string }[]; refused: { id: string; reason: string }[] };
    expect(body.done.map((d) => d.id)).toEqual([a.id]);
    expect(body.refused).toHaveLength(1);
    expect(body.refused[0]).toMatchObject({ id: ghost, reason: "No such ticket." });
  });

  it("does not offer In progress, Review or Done", async () => {
    const c = (ctx = await setup());
    const a = await c.ticket();
    for (const state of ["in_progress", "review", "done"]) {
      expect((await c.bulk([a.id], { type: "move", state })).statusCode).toBeGreaterThanOrEqual(400);
    }
    const [t] = await c.db.select().from(tickets).where(eq(tickets.id, a.id));
    expect(t!.systemState).not.toBe("done");
  });

  it("refuses more than 100 ids and an empty list", async () => {
    const c = (ctx = await setup());
    const many = Array.from({ length: 101 }, () => randomUUID());
    expect((await c.bulk(many, { type: "move", state: "ready" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await c.bulk([], { type: "move", state: "ready" })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("assigns and unassigns an agent", async () => {
    const c = (ctx = await setup());
    const a = await c.ticket();
    const b = await c.ticket();
    const r = await c.bulk([a.id, b.id], { type: "assign", assigneeAgentId: c.worker.id });
    expect((r.json() as { done: unknown[] }).done).toHaveLength(2);
    for (const id of [a.id, b.id]) expect((await c.db.select().from(tickets).where(eq(tickets.id, id)))[0]!.assigneeAgentId).toBe(c.worker.id);
    await c.bulk([a.id], { type: "assign", assigneeAgentId: null });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, a.id)))[0]!.assigneeAgentId).toBeNull();
  });

  it("refuses an agent that is not in the company, per ticket", async () => {
    const c = (ctx = await setup());
    const a = await c.ticket();
    const body = (await c.bulk([a.id], { type: "assign", assigneeAgentId: randomUUID() })).json() as { done: unknown[]; refused: { reason: string }[] };
    expect(body.done).toEqual([]);
    expect(body.refused).toHaveLength(1);
    expect(body.refused[0]!.reason.length).toBeGreaterThan(0);
  });

  it("turns Priority 1 on and off, recording that the owner set it", async () => {
    const c = (ctx = await setup());
    const a = await c.ticket();
    await c.bulk([a.id], { type: "priority", on: true });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, a.id)))[0]).toMatchObject({ urgent: true, urgentByOwner: true });
    await c.bulk([a.id], { type: "priority", on: false });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, a.id)))[0]).toMatchObject({ urgent: false, urgentByOwner: false });
  });
});
