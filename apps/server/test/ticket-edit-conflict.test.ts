import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { projects, tickets } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const [t] = await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Add rate limiting", body: "Original body", systemState: "in_progress" }).returning();
  return { ...built, db, close, req, co, project, dev, ticketId: t!.id };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const row = async () => (await ctx.db.select().from(tickets).where(eq(tickets.id, ctx.ticketId)))[0]!;
/** Someone else changed the description after the page loaded it. */
const changeBodyElsewhere = async () => ctx.db.update(tickets).set({ body: "Changed by the CEO" }).where(eq(tickets.id, ctx.ticketId));

describe("owner edit conflicts (BOS-905, BOS-298 step 13)", () => {
  it("refuses a description edit whose loaded value no longer matches, and leaves the stored text unchanged", async () => {
    const loaded = (await row()).body;
    await changeBodyElsewhere();
    const res = await ctx.req("PATCH", `/api/tickets/${ctx.ticketId}`, { body: "The owner's new words", bodyLoaded: loaded });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "conflict", field: "body" });
    expect(res.json().message).toMatch(/description.*changed/i);
    expect((await row()).body).toBe("Changed by the CEO");
  });

  it("accepts the edit when the loaded value still matches", async () => {
    const loaded = (await row()).body;
    const res = await ctx.req("PATCH", `/api/tickets/${ctx.ticketId}`, { body: "The owner's new words", bodyLoaded: loaded });
    expect(res.statusCode).toBe(200);
    expect((await row()).body).toBe("The owner's new words");
  });

  it("refuses a criteria edit whose loaded criteria changed, and clears the loaded-value only after a match", async () => {
    await ctx.db.update(tickets).set({ acceptanceCriteria: ["Health check returns 200"] }).where(eq(tickets.id, ctx.ticketId));
    await ctx.db.update(tickets).set({ acceptanceCriteria: ["Health check returns 200", "Added by an agent"] }).where(eq(tickets.id, ctx.ticketId));
    const res = await ctx.req("PATCH", `/api/tickets/${ctx.ticketId}`, { acceptanceCriteria: ["Owner's own line"], acceptanceCriteriaLoaded: ["Health check returns 200"] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "conflict", field: "acceptanceCriteria" });
    expect((await row()).acceptanceCriteria).toEqual(["Health check returns 200", "Added by an agent"]);
  });

  it("refuses a title edit whose loaded title changed", async () => {
    await ctx.db.update(tickets).set({ title: "Renamed by an agent" }).where(eq(tickets.id, ctx.ticketId));
    const res = await ctx.req("PATCH", `/api/tickets/${ctx.ticketId}`, { title: "Owner's title", titleLoaded: "Add rate limiting" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "conflict", field: "title" });
    expect((await row()).title).toBe("Renamed by an agent");
  });

  it("lets the owner clear a description that someone else emptied, when that is what they loaded", async () => {
    const loaded = (await row()).body;
    await ctx.db.update(tickets).set({ body: null }).where(eq(tickets.id, ctx.ticketId));
    const res = await ctx.req("PATCH", `/api/tickets/${ctx.ticketId}`, { body: null, bodyLoaded: loaded });
    expect(res.statusCode).toBe(409);
    const ok = await ctx.req("PATCH", `/api/tickets/${ctx.ticketId}`, { body: null, bodyLoaded: null });
    expect(ok.statusCode).toBe(200);
  });

  it("lets a PATCH changing only the assignee through though the ticket's state and version changed since load", async () => {
    await ctx.req("PATCH", `/api/tickets/${ctx.ticketId}`, { state: "review" });
    expect((await row()).version).toBeGreaterThan(1);
    const res = await ctx.req("PATCH", `/api/tickets/${ctx.ticketId}`, { assigneeAgentId: ctx.dev.id, assignedToOwner: false });
    expect(res.statusCode).toBe(200);
    expect(await row()).toMatchObject({ assigneeAgentId: ctx.dev.id });
  });

  it("a PATCH without the loaded values behaves exactly as today", async () => {
    await changeBodyElsewhere();
    const res = await ctx.req("PATCH", `/api/tickets/${ctx.ticketId}`, { body: "Plain save", title: "Plain title" });
    expect(res.statusCode).toBe(200);
    expect(await row()).toMatchObject({ body: "Plain save", title: "Plain title" });
  });
});
