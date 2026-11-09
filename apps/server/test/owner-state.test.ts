import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, reviewRequests, tickets, wakes } from "../src/db/schema.js";

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
  return { ...built, db, close, req, worker, ticket };
}

describe("owner moves a ticket's state", () => {
  it("done closes it without landing, and frees what waited on it", async () => {
    const c = (ctx = await setup());
    const a = await c.ticket({ assigneeAgentId: c.worker.id });
    const b = await c.ticket();
    await c.req("POST", `/api/tickets/${b.id}/dependencies`, { ticketId: a.id });
    await c.req("PATCH", `/api/tickets/${b.id}`, { state: "blocked" });
    await c.req("PATCH", `/api/tickets/${a.id}`, { state: "in_progress" });
    const r = await c.req("POST", `/api/tickets/${a.id}/state`, { state: "done" });
    expect(r.statusCode).toBe(200);
    const [done] = await c.db.select().from(tickets).where(eq(tickets.id, a.id));
    expect(done).toMatchObject({ systemState: "done", outcome: "completed" });
    const [freed] = await c.db.select().from(tickets).where(eq(tickets.id, b.id));
    expect(freed!.systemState).toBe("ready");
    expect((await c.db.select().from(activity).where(eq(activity.ticketId, a.id))).map((x) => x.summary)).toContain("in_progress -> done: Owner moved it to Done");
    // Its waiting wake-ups are dropped, so nobody starts work on a closed ticket.
    expect((await c.db.select().from(wakes).where(eq(wakes.ticketId, a.id))).filter((w) => w.status === "queued" || w.status === "deferred")).toEqual([]);
  });

  it("review requests the reviews", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket({ assigneeAgentId: c.worker.id });
    await c.req("PATCH", `/api/tickets/${t.id}`, { state: "in_progress" });
    await c.db.delete(wakes);
    expect((await c.req("POST", `/api/tickets/${t.id}/state`, { state: "review" })).statusCode).toBe(200);
    expect((await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id))).length).toBeGreaterThan(0);
  });

  it("in progress wakes the assignee with a note; backlog does not", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket({ assigneeAgentId: c.worker.id });
    await c.req("PATCH", `/api/tickets/${t.id}`, { state: "blocked" });
    await c.db.delete(wakes);
    await c.req("POST", `/api/tickets/${t.id}/state`, { state: "backlog" });
    expect(await c.db.select().from(wakes)).toEqual([]);
    await c.req("POST", `/api/tickets/${t.id}/state`, { state: "in_progress" });
    expect(await c.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: c.worker.id, ticketId: t.id, reason: "woken by owner", note: "The owner moved this ticket to In progress." })]);
  });

  it("rejects an unknown state", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket();
    expect((await c.req("POST", `/api/tickets/${t.id}/state`, { state: "nope" })).statusCode).toBe(400);
  });
});
