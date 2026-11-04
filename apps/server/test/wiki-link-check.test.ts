import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ownerChatMessages, runners, ticketMessages } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { LINK_LOOKUPS, LINK_SCAN_CHARS, wikilinkSlugs } from "../src/services/wiki.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
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
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const starts = () => sent.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  const mcp = async (runId: string, agentId: string = worker.id) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, req, company, ceo, worker, project, sent, emit, settle, starts, mcp };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("wiki link check (BOS-359)", () => {
  it("reads [[slug]] and [[slug#Heading]] once each, and caps the number of slugs", () => {
    expect(wikilinkSlugs("See [[engineering/architecture/bos-356]] and [[same]] and [[same#Part]].")).toEqual(["engineering/architecture/bos-356", "same"]);
    // A long message is not scanned past the cap.
    const many = Array.from({ length: LINK_LOOKUPS + 5 }, (_, i) => `[[page-${i}]]`).join(" ");
    expect(wikilinkSlugs(many)).toHaveLength(LINK_LOOKUPS);
    // Text past LINK_SCAN_CHARS is ignored, so a huge message costs no more than a short one.
    const hidden = "x".repeat(LINK_SCAN_CHARS) + "[[too-late]]";
    expect(wikilinkSlugs(hidden)).toEqual([]);
    expect(wikilinkSlugs("plain text, no links")).toEqual([]);
  });

  it("adds a note naming a page that isn't there to ticket_reply, and leaves the saved text as written", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Fix the footer", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.scheduler.tick();
    const client = await c.mcp(c.starts()[0]!.runId);
    const body = "Done. The notes are in [[research/missing-page]] and [[research/also-gone#Part]].";
    const reply = textOf(await client.callTool({ name: "ticket_reply", arguments: { ticketId: t.id, text: body } }));
    expect(reply).toContain('to no such page: "research/missing-page", "research/also-gone"');
    expect(reply).toContain("The text was saved as written.");
    await client.close();
    // The stored reply is exactly what the agent wrote.
    expect((await c.db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, t.id)))[0]).toMatchObject({ text: body });
  });

  it("quietly accepts a reply that links a page that does exist", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Fix the footer", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.scheduler.tick();
    const client = await c.mcp(c.starts()[0]!.runId);
    await client.callTool({ name: "wiki", arguments: { action: "write", folder: "Research", title: "Existing", body: "Here.", ticketId: t.id } });
    expect(textOf(await client.callTool({ name: "ticket_reply", arguments: { ticketId: t.id, text: "See [[research/existing]] and [[research/existing#Top]]." } }))).toBe("Posted on the ticket's conversation.");
    await client.close();
  });

  it("names a missing page in a decision and an owner note too", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Deploy it", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.scheduler.tick();
    const client = await c.mcp(c.starts()[0]!.runId);
    const decision = textOf(await client.callTool({ name: "raise_decision", arguments: { question: "Read [[engineering/rfc-that-is-gone]] and approve?", options: ["Done", "Not yet"], recommended: "Done", blocksTicketId: t.id, triedFirst: "I tried to deploy here, but the change touches deployment files the host refuses." } }));
    expect(decision).toContain('to no such page: "engineering/rfc-that-is-gone"');
    const note = textOf(await client.callTool({ name: "notify_owner", arguments: { level: "note", title: "Report ready", body: "See [[reports/week-that-is-gone]].", ticketId: t.id } }));
    expect(note).toContain('to no such page: "reports/week-that-is-gone"');
    expect(note.startsWith("Sent as a note.")).toBe(true);
    await client.close();
  });

  it("names a missing page under the CEO's chat reply, leaving its words as written", async () => {
    const c = (ctx = await setup());
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Where are the notes?" });
    c.sent.length = 0;
    await c.scheduler.tick();
    const start = c.starts()[0]!;
    const words = "The notes are in [[product/notes-that-are-gone]].";
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: words } });
    await c.emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const saved = (await c.db.select().from(ownerChatMessages).where(eq(ownerChatMessages.role, "assistant")))[0]!;
    expect(saved.text).toContain(words);
    expect(saved.text).toContain('to no such page: "product/notes-that-are-gone"');
  });
});
