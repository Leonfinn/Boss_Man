// BOS-1361: closing a ticket that hands work on opens the follow-up (followUps), and done is refused
// when the wording hands work on and neither followUps nor noFollowUpReason is given.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ticketMessages, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { handOffPhrase } from "../src/services/hand-offs.js";

let server: Awaited<ReturnType<typeof boot>>;
let ctx: Awaited<ReturnType<typeof setup>>;

async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return { built, db, close, base, cookie, companies: 0 };
}

async function setup() {
  const { built, db, base, cookie } = server;
  const clients: Client[] = [];
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: `Hand-off Co ${++server.companies}` })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  // A no-code ticket its own assignee closes, so the tests reach the done gate without a branch.
  const ticket = async (patch: Record<string, unknown> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Backfill features", systemState: "in_progress", noCode: true, assigneeAgentId: dev.id, ...patch }).returning())[0]!;
  const agent = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { db, req, co, dev, project, ticket, agent, done: async () => { await Promise.all(clients.map((c) => c.close())); } };
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

beforeAll(async () => { server = await boot(); }, 120_000);
afterAll(async () => { await server.built.app.close(); await server.close(); });
beforeEach(async () => { ctx = await setup(); });
afterEach(async () => { await ctx.done(); });

describe("the hand-off wording", () => {
  it("catches the BOS-958 wording and the other listed phrasings", () => {
    for (const s of [
      "Done. The CEO will attach them to the features.",
      "Schema in; for the CEO to wire up the board next.",
      "Backfill ready, handed to Brains for the rest.",
      "Hand off to Rod once he is back.",
      "Next: someone picks up the docs.",
      "Brains will create the 34 features.",
    ]) expect(handOffPhrase(s), s).not.toBeNull();
  });

  it("leaves ordinary done summaries alone", () => {
    for (const s of [
      "Wrote the page; every criterion passes.",
      "It will create a row for each device. Tests pass; 1 pass; 2 pass.",
      "Merged. The migration will add a column; checked live, 1 pass.",
      "Research done: three options compared, recommendation on the wiki page.",
      "Closed as a duplicate: the change shipped on BOS-1200.",
      "Fixed the CEO card wake; the CEO now gets every card.",
      "Added the hand-off wording check and its tests.",
      "Cancelled: the owner decided against it.",
    ]) expect(handOffPhrase(s), s).toBeNull();
  });
});

describe("set_ticket_state done with hand-off wording", () => {
  it("is refused with no followUps, and the ticket stays put", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Schema done. The CEO will attach the features." } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toContain("followUps");
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
  });

  it("reads the last reply too", async () => {
    const t = await ctx.ticket();
    await ctx.db.insert(ticketMessages).values({ companyId: ctx.co.company.id, ticketId: t.id, author: "agent", agentId: ctx.dev.id, text: "All 34 are listed; the CEO will attach them." });
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Finished." } });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });

  it("noFollowUpReason lets it through", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Done. The CEO will attach them.", noFollowUpReason: "Already attached on BOS-1; wording is left over." } });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("done");
  });

  it("an ordinary summary is not refused", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Wrote the page; tests pass." } });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
  });

  it("followUps opens a linked ticket for the CEO in the same project and feature, and the move goes through", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Done. The CEO will attach them.", followUps: [{ title: "Attach the 34 features", assignee: "CEO", why: "BOS-958 listed them but nothing attached them." }] } });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    expect(textOf(r)).toContain("opened the follow-up");
    const made = (await ctx.db.select().from(tickets)).find((x) => x.title === "Attach the 34 features")!;
    expect(made.projectId).toBe(ctx.project.id);
    expect(made.assigneeAgentId).toBe(ctx.co.ceo.id);
    expect(made.body).toContain(`#/tickets/${t.id}`);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.stateNote).toContain(`#/tickets/${made.id}`);
  });

  it("a wrong assignee name refuses the move before anything changes", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Wrote the page.", followUps: [{ title: "Do more", assignee: "Nobody", why: "x" }] } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
  });
});
