import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { missingVerdicts, readVerdicts } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Add rate limiting", systemState: "in_progress", ...patch }).returning())[0]!;
  return { ...built, db, close, base, req, co, dev, project, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

async function agent(agentId: string, runId = randomUUID()) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId, runId });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

const CRITERIA = ["Health check returns 200", "Migration is expand-only", "Secrets are never logged"];

describe("acceptance criteria", () => {
  it("the verdict parser reads pass and fail next to each criterion and leaves the rest missing", () => {
    const note = "Done. Health check returns 200: pass. \"Migration is expand-only\" — fail. Everything checked.";
    const rows = readVerdicts(CRITERIA, note);
    expect(rows.map((r) => r.verdict)).toEqual(["pass", "fail", null]);
    expect(missingVerdicts(CRITERIA, note)).toEqual(["Secrets are never logged"]);
    expect(missingVerdicts(CRITERIA, "Pass: Health check returns 200. Pass: Migration is expand-only. Pass: Secrets are never logged.")).toEqual([]);
    expect(missingVerdicts(CRITERIA, null)).toEqual(CRITERIA);
  });

  it("a sentence with a fail word reads as fail even when it also says \"nothing green\"", () => {
    const rows = readVerdicts(["Migration is expand-only"], "Migration is expand-only fail, tests fail, nothing green.");
    expect(rows).toEqual([{ criterion: "Migration is expand-only", verdict: "fail" }]);
  });

  it("create_ticket accepts 1 to 10 criteria and refuses 11; the tickets tool shows them", async () => {
    const c = await agent(ctx.dev.id);
    const ten = Array.from({ length: 10 }, (_, i) => `criterion ${i + 1}`);
    const ok = await c.callTool({ name: "create_ticket", arguments: { project: "Customer app", title: "With criteria", acceptanceCriteria: ten } });
    expect(textOf(ok)).toMatch(/Created ticket/);
    const eleven = [...ten, "criterion 11"];
    const refused = await c.callTool({ name: "create_ticket", arguments: { project: "Customer app", title: "Too many", acceptanceCriteria: eleven } });
    expect(textOf(refused)).toMatch(/too_big|10/i);
    const created = (await ctx.db.select().from(tickets).where(eq(tickets.title, "With criteria")))[0]!;
    const shown = textOf(await c.callTool({ name: "tickets", arguments: { action: "read", ticketId: created.id } }));
    expect(shown).toMatch(/## Acceptance criteria/);
    expect(shown).toContain("[not reported] criterion 1");
    await c.close();
  });

  it("moving a ticket with criteria to review without a pass/fail for each is refused, naming the missing ones", async () => {
    const t = await ctx.ticket({ acceptanceCriteria: CRITERIA });
    const c = await agent(ctx.dev.id);
    const refused = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "It's done; tests pass." } });
    expect(textOf(refused)).toMatch(/pass or fail for each/);
    expect(textOf(refused)).toContain("Secrets are never logged");
    expect(textOf(refused)).toContain("Health check returns 200");

    const good = await c.callTool({
      name: "set_ticket_state",
      arguments: { ticketId: t.id, state: "review", summary: "Health check returns 200 pass; migration expand-only pass; secrets never logged pass." },
    });
    expect(textOf(good)).toContain("is now review");
    const [after] = await ctx.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(after!.systemState).toBe("review");
    await c.close();
  });

  it("a ticket without criteria moves to review exactly as before", async () => {
    const t = await ctx.ticket();
    const c = await agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Plain note." } });
    expect(textOf(r)).toContain("is now review");
    await c.close();
  });

  it("the review wake note carries the criteria checklist with the author's verdicts", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: CRITERIA });
    const c = await agent(ctx.dev.id);
    await c.callTool({
      name: "set_ticket_state",
      arguments: { ticketId: t.id, state: "review", summary: "Health check returns 200 pass; Migration is expand-only pass; Secrets are never logged fail." },
    });
    await c.close();
    const reviewerWakes = (await ctx.db.select().from(wakes)).filter((w) => w.agentId === ctx.co.ceo.id && w.reason === "review requested");
    const note = reviewerWakes.at(-1)?.note ?? "";
    expect(note).toContain("Acceptance criteria:");
    expect(note).toContain("[pass] Migration is expand-only");
    expect(note).toContain("[pass] Health check returns 200");
    expect(note).toContain("[fail] Secrets are never logged");
  });

  it("the owner creates, edits and clears criteria through the ticket API", async () => {
    const created = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Owner made", acceptanceCriteria: ["Health check returns 200"] })).json() as { id: string; acceptanceCriteria: string[] };
    expect(created.acceptanceCriteria).toEqual(["Health check returns 200"]);
    const edited = await ctx.req("PATCH", `/api/tickets/${created.id}`, { acceptanceCriteria: ["Health check returns 200", "Secrets are never logged"] });
    expect(edited.json().acceptanceCriteria).toEqual(["Health check returns 200", "Secrets are never logged"]);
    const cleared = await ctx.req("PATCH", `/api/tickets/${created.id}`, { acceptanceCriteria: [] });
    expect(cleared.json().acceptanceCriteria).toEqual([]);
    const blank = await ctx.req("PATCH", `/api/tickets/${created.id}`, { acceptanceCriteria: ["   "] });
    expect(blank.statusCode).toBe(400);
  });
});