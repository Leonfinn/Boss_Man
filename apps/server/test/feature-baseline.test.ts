// BOS-2682: a feature is baselined when it is released. A ticket may only join it for an exception (a bug fix that
// restores what it promised, with exceptionReason), and tickets Boss Man opens by itself (follow-ups from a close,
// after-merge watches, failed-check fixes) are filed with no feature, so the feature can close. The one automatic
// exception: a follow-up carrying a failed or unreported criterion of a feature that is not released yet.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, features, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let server: Awaited<ReturnType<typeof boot>>;
let ctx: Awaited<ReturnType<typeof setup>>;

async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return { built, db, close, base, cookie, companies: 0, clients: [] as Client[] };
}

async function setup() {
  const { built, db, base, cookie } = server;
  const clients: Client[] = [];
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: `Baseline Co ${++server.companies}` })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const feature = async (patch: Record<string, unknown> = {}) => (await db.insert(features).values({ companyId: co.company.id, title: `Feature ${randomUUID().slice(0, 6)}`, status: "in_progress", ...patch }).returning())[0]!;
  const ticket = async (patch: Record<string, unknown> = {}) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Backfill features", systemState: "in_progress", noCode: true, assigneeAgentId: dev.id, ...patch }).returning())[0]!;
  const agent = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { db, req, co, dev, project, feature, ticket, agent, done: async () => { await Promise.all(clients.map((c) => c.close())); } };
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

beforeAll(async () => { server = await boot(); }, 120_000);
afterAll(async () => { await server.built.app.close(); await server.close(); });
beforeEach(async () => { ctx = await setup(); });
afterEach(async () => { await ctx.done(); });

describe("a released feature is baselined", () => {
  it("create_ticket refuses to join a released feature, and an exceptionReason lets it in with the reason kept", async () => {
    const f = await ctx.feature({ status: "released", releasedAt: new Date() });
    const ceo = await ctx.agent(ctx.co.ceo.id);
    const refused = await ceo.callTool({ name: "create_ticket", arguments: { title: "Dark mode on the settings page", project: "Customer app", size: 1, featureId: f.id } });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(textOf(refused)).toContain("baselined");
    expect(textOf(refused)).toContain("create_feature");
    expect((await ctx.db.select().from(tickets)).filter((x) => x.title === "Dark mode on the settings page")).toEqual([]);

    const allowed = await ceo.callTool({ name: "create_ticket", arguments: { title: "Fix dark mode toggle", project: "Customer app", size: 1, featureId: f.id, exceptionReason: "The dark mode toggle does nothing on the settings page" } });
    expect((allowed as { isError?: boolean }).isError, textOf(allowed)).toBeFalsy();
    const made = (await ctx.db.select().from(tickets)).find((x) => x.title === "Fix dark mode toggle")!;
    expect(made.featureId).toBe(f.id);
    const line = (await ctx.db.select().from(activity).where(eq(activity.ticketId, made.id))).find((a) => a.summary.includes("as an exception"));
    expect(line?.summary).toContain("The dark mode toggle does nothing");
  });

  it("an unreleased feature takes tickets as before, with no exceptionReason needed", async () => {
    const f = await ctx.feature({ status: "in_progress" });
    const ceo = await ctx.agent(ctx.co.ceo.id);
    const r = await ceo.callTool({ name: "create_ticket", arguments: { title: "Dark mode on the board", project: "Customer app", size: 1, featureId: f.id } });
    expect((r as { isError?: boolean }).isError, textOf(r)).toBeFalsy();
    expect((await ctx.db.select().from(tickets)).find((x) => x.title === "Dark mode on the board")!.featureId).toBe(f.id);
  });

  it("update_ticket refuses a move onto a released feature unless exceptionReason is given, and keeps the reason", async () => {
    const f = await ctx.feature({ status: "released", releasedAt: new Date() });
    const t = await ctx.ticket();
    const ceo = await ctx.agent(ctx.co.ceo.id);
    const refused = await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, featureId: f.id, reason: "delivers dark mode" } });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(textOf(refused)).toContain("baselined");
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.featureId).toBeNull();
    // exceptionReason without a featureId is refused too: it is the reason for joining, nothing else.
    const orphan = await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, title: "Renamed", exceptionReason: "x", reason: "tidy" } });
    expect((orphan as { isError?: boolean }).isError).toBe(true);

    const allowed = await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, featureId: f.id, exceptionReason: "The release shipped without the toggle", reason: "bug fix restoring it" } });
    expect((allowed as { isError?: boolean }).isError, textOf(allowed)).toBeFalsy();
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.featureId).toBe(f.id);
    expect((await ctx.db.select().from(activity).where(eq(activity.ticketId, t.id))).some((a) => a.summary.includes("The release shipped without the toggle"))).toBe(true);
    // A ticket already on the released feature is not joining it again: its other writes are not held up.
    const rename = await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, title: "Fix the dark mode toggle", reason: "clearer title" } });
    expect((rename as { isError?: boolean }).isError, textOf(rename)).toBeFalsy();
  });

  it("the feature's own add-a-ticket route refuses a released feature", async () => {
    const f = await ctx.feature({ status: "released", releasedAt: new Date() });
    const res = await ctx.req("POST", `/api/features/${f.id}/tickets`, { projectId: ctx.project.id });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { message: string }).message).toContain("baselined");
  });
});

describe("follow-ups and auto-opened tickets do not join the feature (BOS-2682)", () => {
  it("a follow-up of a ticket in a released feature is opened with no feature", async () => {
    const f = await ctx.feature({ status: "released", releasedAt: new Date() });
    const t = await ctx.ticket({ featureId: f.id });
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Wrote the page.", followUps: [{ title: "Tidy the settings copy", assignee: "CEO", why: "The copy could be clearer." }] } });
    expect((r as { isError?: boolean }).isError, textOf(r)).toBeFalsy();
    const made = (await ctx.db.select().from(tickets)).find((x) => x.title === "Tidy the settings copy")!;
    expect(made.featureId).toBeNull();
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.stateNote).toContain("filed with no feature");
  });

  it("a follow-up of an unreleased feature with no criterion to carry is opened with no feature", async () => {
    const f = await ctx.feature({ status: "in_progress" });
    const t = await ctx.ticket();
    // Set after the ticket exists, so the feature's own sync (which releases a feature whose only ticket is done) leaves it alone.
    await ctx.db.update(tickets).set({ featureId: f.id }).where(eq(tickets.id, t.id));
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Wrote the page.", followUps: [{ title: "Write the guide next", assignee: "CEO", why: "A user asked for one." }] } });
    expect((r as { isError?: boolean }).isError, textOf(r)).toBeFalsy();
    expect((await ctx.db.select().from(tickets)).find((x) => x.title === "Write the guide next")!.featureId).toBeNull();
  });

  it("a follow-up carrying an unreleased feature's failed criterion joins it, and the ticket says why", async () => {
    const f = await ctx.feature({ status: "in_progress" });
    // Two tickets: one done and one still open, so the feature is not released by the close below (BOS-2682's rule is
    // about a feature that still promises work). The carrying ticket is the one that closes.
    const keepOpen = await ctx.ticket();
    await ctx.db.update(tickets).set({ featureId: f.id }).where(eq(tickets.id, keepOpen.id));
    const t = await ctx.ticket({ acceptanceCriteria: ["Dark mode is on by default"] });
    await ctx.db.update(tickets).set({ featureId: f.id, stateNote: "1 fail: the toggle shipped off" }).where(eq(tickets.id, t.id));
    expect((await ctx.db.select().from(features).where(eq(features.id, f.id)))[0]!.status).toBe("in_progress");
    const c = await ctx.agent(ctx.co.ceo.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Handing the toggle on.", followUps: [{ title: "Turn dark mode on by default", assignee: "Dev", why: "It shipped off." }] } });
    expect((r as { isError?: boolean }).isError, textOf(r)).toBeFalsy();
    expect((await ctx.db.select().from(features).where(eq(features.id, f.id)))[0]!.status).toBe("in_progress");
    const made = (await ctx.db.select().from(tickets)).find((x) => x.title === "Turn dark mode on by default")!;
    expect(made.featureId).toBe(f.id);
    expect(made.body).toContain(`Why it is in the feature "${f.title}"`);
    // The carried criterion is first; a feature ticket also gets the built-in usability gate.
    expect(made.acceptanceCriteria[0]).toBe("Dark mode is on by default");
  });

  it("a follow-up carrying a released feature's criterion stays out of it", async () => {
    const f = await ctx.feature({ status: "released", releasedAt: new Date() });
    const t = await ctx.ticket({ acceptanceCriteria: ["Dark mode is on by default"] });
    await ctx.db.update(tickets).set({ featureId: f.id, stateNote: "1 fail: the toggle shipped off" }).where(eq(tickets.id, t.id));
    const c = await ctx.agent(ctx.co.ceo.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Handing the toggle on.", followUps: [{ title: "Turn dark mode on by default", assignee: "Dev", why: "It shipped off." }] } });
    expect((r as { isError?: boolean }).isError, textOf(r)).toBeFalsy();
    // This test's own follow-up: the one handed on by this ticket, in this company's project.
    const [followUp] = await ctx.db.select().from(tickets).where(and(eq(tickets.projectId, ctx.project.id), eq(tickets.title, "Turn dark mode on by default"), eq(tickets.companyId, ctx.co.company.id)));
    // The criterion still travels (the outcome isn't lost), but the delivered feature does not take the ticket.
    expect(followUp!.acceptanceCriteria[0]).toBe("Dark mode is on by default");
    expect(followUp!.featureId).toBeNull();
  });
});
