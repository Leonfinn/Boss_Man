// BOS-2731 through the real /mcp endpoint: an agent's call that holds a secret is refused by name of rule only, and nothing is saved.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { issueRunToken } from "../src/mcp.js";
import { runs, ticketMessages, tickets } from "../src/db/schema.js";

// Built at run time so this file holds no key-shaped text.
const rnd = "aB3dE5gH7jK9mN1pQ3sT5vX7zC2fG4hJ6kL8";
const key = ["sk", "ant", "api03"].join("-") + "-" + rnd;

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await Promise.all((ctx?.clients ?? []).map((c) => c.close().catch(() => undefined)));
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "GET", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Work", assigneeAgentId: worker.id })).json() as { id: string };
  const say = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "") as string;
  const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
  return { ...built, db, close, req, ceo, worker, mcp, clients, ticketId: t.id, say, isError };
}

describe("agent writes with a secret are refused (BOS-2731)", { timeout: 30_000 }, () => {
  it("ticket_reply, wiki write and create_ticket refuse a key, name the rule only, and save nothing", async () => {
    const c = (ctx = await setup());
    const worker = await c.mcp(c.worker.id);
    const before = (await c.db.select().from(ticketMessages)).length;

    const reply = await worker.callTool({ name: "ticket_reply", arguments: { ticketId: c.ticketId, text: `The key is ${key}` } });
    expect(c.isError(reply)).toBe(true);
    expect(c.say(reply)).toContain("anthropic-key");
    expect(c.say(reply)).not.toContain(rnd);
    expect((await c.db.select().from(ticketMessages)).length).toBe(before);

    const wiki = await worker.callTool({ name: "wiki", arguments: { action: "write", title: "Notes", body: `token ${key}` } });
    expect(c.isError(wiki)).toBe(true);
    expect(c.say(wiki)).toContain("anthropic-key");
    const list = c.say(await worker.callTool({ name: "wiki", arguments: { action: "list", q: "Notes" } }));
    expect(list).not.toMatch(/\bNotes\b/);

    const ceo = await c.mcp(c.ceo.id);
    const made = await ceo.callTool({ name: "create_ticket", arguments: { title: "New work", body: `use ${key}`, assignee: "Engineer", noCode: true, size: 2 } });
    expect(c.isError(made)).toBe(true);
    expect(c.say(made)).toContain("anthropic-key");
    expect((await c.db.select().from(tickets).where(eq(tickets.title, "New work"))).length).toBe(0);
  });

  it("text saved before the check is untouched and still readable", async () => {
    const c = (ctx = await setup());
    const [t] = await c.db.select().from(tickets).where(eq(tickets.id, c.ticketId));
    await c.db.update(tickets).set({ body: `old text with ${key}` }).where(eq(tickets.id, t!.id));
    const worker = await c.mcp(c.worker.id);
    const read = await worker.callTool({ name: "tickets", arguments: { action: "read", ticketId: c.ticketId } });
    expect(c.isError(read)).toBe(false);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticketId)))[0]!.body).toBe(`old text with ${key}`);
  });

  it("the CEO's owner chat is guarded too: a key pasted there is refused when the CEO writes it into a ticket reply or the wiki", async () => {
    const c = (ctx = await setup());
    const [run] = await c.db.insert(runs).values({ companyId: (await c.db.select().from(tickets).where(eq(tickets.id, c.ticketId)))[0]!.companyId, agentId: c.ceo.id, purpose: "chat" }).returning();
    const companyId = run!.companyId;
    const token = await issueRunToken(c.db, { companyId, agentId: c.ceo.id, runId: run!.id });
    const base = `127.0.0.1:${(c.app.server.address() as { port: number }).port}`;
    const chat = new Client({ name: "t", version: "0" });
    await chat.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    c.clients.push(chat);
    const before = (await c.db.select().from(ticketMessages)).length;
    const reply = await chat.callTool({ name: "ticket_reply", arguments: { ticketId: c.ticketId, text: `The key is ${key}` } });
    expect(c.isError(reply)).toBe(true);
    expect(c.say(reply)).toContain("anthropic-key");
    expect((await c.db.select().from(ticketMessages)).length).toBe(before);
    const wiki = await chat.callTool({ name: "wiki", arguments: { action: "write", title: "Chat notes", body: `token ${key}` } });
    expect(c.isError(wiki)).toBe(true);
    expect(c.say(wiki)).toContain("anthropic-key");
  });

  it("the same call without the key goes through", async () => {
    const c = (ctx = await setup());
    const worker = await c.mcp(c.worker.id);
    const ok = await worker.callTool({ name: "ticket_reply", arguments: { ticketId: c.ticketId, text: "Done. The key comes from $ANTHROPIC_API_KEY." } });
    expect(c.isError(ok)).toBe(false);
  });
});
