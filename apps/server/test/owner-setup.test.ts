import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

const EMPTY: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "a".repeat(40), commits: [], files: [], diff: "", truncated: false };

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { ...EMPTY, head: "b".repeat(40), files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff" } }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "Nothing taken." } }));
    return true;
  });
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Second Claude account", systemState: "in_progress", assigneeAgentId: dev.id, branch: "bossman/x", ownerSetupWhy: "The second account is used when the first runs out.", ownerSetupIfSkipped: "Nothing breaks; the second account just isn't used.", ...patch }).returning())[0]!;
  return { ...built, db, close, base, req, co, dev, project, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

async function agentFor(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const row = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

describe("a ticket carries the owner's setup steps (DR-011)", () => {
  it("create_ticket advertises ownerSetup and stores it", async () => {
    const c = await agentFor(ctx.dev.id);
    const tool = (await c.listTools()).tools.find((x) => x.name === "create_ticket")!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain("ownerSetup");
    const out = textOf(await c.callTool({ name: "create_ticket", arguments: { size: 2, project: "Customer app", title: "Second account", ownerSetup: "Settings → Funding → Add funding source", ownerSetupWhy: "Lets the team switch to a second account.", ownerSetupIfSkipped: "Nothing breaks." } }));
    const id = /([0-9a-f-]{36})/.exec(out)![1]!;
    expect((await row(id)).ownerSetup).toBe("Settings → Funding → Add funding source");
  });

  it("the ticket's own author sets it with set_ticket_state, and the move-to-review reply reminds them when it's missing", async () => {
    const c = await agentFor(ctx.dev.id);
    const t = await ctx.ticket();
    const moved = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Built it." } }));
    expect(moved).toMatch(/has to do anything once this is live/);
    expect((await row(t.id)).ownerSetup).toBeNull();
    // Another move can carry the steps; the field is theirs to write.
    await ctx.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, t.id));
    // Steps for the owner bring the usability gate (BOS-1571), which the author reports like any criterion.
    textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Built it. 1 pass: one-time setup, nothing to repeat.", ownerSetup: "Settings → Funding → Add funding source\nSign in to the second plan" } }));
    expect((await row(t.id)).ownerSetup).toBe("Settings → Funding → Add funding source\nSign in to the second plan");
  });

  it("the ticket read shows the steps to a reviewer, and the diff looks at them", async () => {
    const t = await ctx.ticket({ ownerSetup: "Settings → Funding → Add funding source" });
    const c = await agentFor(ctx.dev.id);
    const read = textOf(await c.callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id } }));
    expect(read).toContain("After it goes live, the owner will need to");
    expect(read).toContain("Settings → Funding → Add funding source");
  });

  it("the owner's web form saves and clears the steps", async () => {
    const t = await ctx.ticket();
    expect((await ctx.req("PATCH", `/api/tickets/${t.id}`, { ownerSetup: "Settings → Funding → Add funding source" })).statusCode).toBe(200);
    expect((await row(t.id)).ownerSetup).toBe("Settings → Funding → Add funding source");
    await ctx.req("PATCH", `/api/tickets/${t.id}`, { ownerSetup: "" });
    expect((await row(t.id)).ownerSetup).toBeNull();
  });

  it("a worker can't set it on a ticket that isn't theirs", async () => {
    const other = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/agents`, { name: "Someone else" })).json() as { id: string };
    const t = await ctx.ticket();
    const c = await agentFor(other.id);
    const out = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "x", ownerSetup: "Settings → Funding" } }));
    expect(out).toMatch(/isn't yours/);
    expect((await row(t.id)).ownerSetup).toBeNull();
  });

  it("a manager sets it with update_ticket", async () => {
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    const t = await ctx.ticket();
    const c = await agentFor(ctx.dev.id);
    textOf(await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: "Settings → Funding → Add funding source", reason: "Steps for the owner." } }));
    expect((await row(t.id)).ownerSetup).toBe("Settings → Funding → Add funding source");
  });

  it("once merged, an agent can't change the steps with update_ticket; the owner can", async () => {
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    const t = await ctx.ticket({ ownerSetup: "Settings → Funding → Add funding source", mergeCommit: "c".repeat(40) });
    const c = await agentFor(ctx.dev.id);
    const out = textOf(await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: "Settings → Funding → Delete the account", reason: "Better steps." } }));
    expect(out).toMatch(/merged, so its setup steps are frozen/);
    expect((await row(t.id)).ownerSetup).toBe("Settings → Funding → Add funding source");
    // The owner's own web edit still works.
    expect((await ctx.req("PATCH", `/api/tickets/${t.id}`, { ownerSetup: "Settings → Funding → Delete the account" })).statusCode).toBe(200);
    expect((await row(t.id)).ownerSetup).toBe("Settings → Funding → Delete the account");
  });

  it("once merged, set_ticket_state can't change the steps either", async () => {
    const t = await ctx.ticket({ ownerSetup: "Settings → Funding → Add funding source", mergeCommit: "c".repeat(40) });
    const c = await agentFor(ctx.dev.id);
    const out = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Reopened.", ownerSetup: "Settings → Funding → Add funding source\nAnd more" } }));
    expect(out).toMatch(/merged, so its setup steps are frozen/);
    expect((await row(t.id)).ownerSetup).toBe("Settings → Funding → Add funding source");
  });

  it("a manager's setup-step change before the merge is named in the activity log", async () => {
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    const t = await ctx.ticket();
    const c = await agentFor(ctx.dev.id);
    textOf(await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: "Settings → Funding → Add funding source", reason: "Steps for the owner." } }));
    const log = (await ctx.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((e) => e.summary).join("\n");
    expect(log).toContain("reorganised it (owner setup steps changed): Steps for the owner.");
    // The owner's edit is logged too.
    await ctx.req("PATCH", `/api/tickets/${t.id}`, { ownerSetup: "" });
    const after = (await ctx.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((e) => e.summary).join("\n");
    expect(after).toContain("The owner changed the owner's setup steps");
  });
});

describe("setup steps are checked like an owner card when they are written (DR-052)", () => {
  const VAGUE = "Delete BOSSMAN_CHECK_SLOTS from .env\nRestart the notifications add-on";
  const GOOD = "Delete the BOSSMAN_CHECK_SLOTS line from {{host.env.file}}: `sed -i '/^BOSSMAN_CHECK_SLOTS=/d' {{host.env.file}}`. This prints nothing.";
  /** The company's own CEO (every company has one). */
  const ceoAgent = async () => agentFor((await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, ctx.co.company.id), eq(agents.role, "ceo"))))[0]!.id);

  it("create_ticket refuses vague steps, naming the step and the token to use, and takes good ones", async () => {
    const c = await agentFor(ctx.dev.id);
    const out = textOf(await c.callTool({ name: "create_ticket", arguments: { size: 2, project: "Customer app", title: "Fewer check slots", ownerSetup: VAGUE, ownerSetupWhy: "Frees check slots.", ownerSetupIfSkipped: "Nothing breaks." } }));
    expect(out).toMatch(/Step 1: names \.env without saying where it is/);
    expect(out).toMatch(/Step 2: says "Restart the notifications add-on"/);
    expect(out).toContain("{{host.env.file}}");
    expect(await ctx.db.select().from(tickets).where(eq(tickets.title, "Fewer check slots"))).toHaveLength(0);
    const ok = textOf(await c.callTool({ name: "create_ticket", arguments: { size: 2, project: "Customer app", title: "Fewer check slots", ownerSetup: GOOD, ownerSetupWhy: "Frees check slots.", ownerSetupIfSkipped: "Nothing breaks." } }));
    expect((await row(/([0-9a-f-]{36})/.exec(ok)![1]!)).ownerSetup).toBe(GOOD);
  });

  // BOS-1650: steps need their "why" and "if skipped" lines.
  it("create_ticket and set_ticket_state refuse steps without why or if-skipped, and store them when given", async () => {
    const c = await agentFor(ctx.dev.id);
    const out = textOf(await c.callTool({ name: "create_ticket", arguments: { size: 2, project: "Customer app", title: "No reason", ownerSetup: GOOD } }));
    expect(out).toMatch(/ownerSetupWhy is missing/);
    expect(out).toMatch(/ownerSetupIfSkipped is missing/);
    expect(await ctx.db.select().from(tickets).where(eq(tickets.title, "No reason"))).toEqual([]);
    const t = await ctx.ticket({ ownerSetupWhy: null, ownerSetupIfSkipped: null });
    const noWhy = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Working.", ownerSetup: GOOD } }));
    expect(noWhy).toMatch(/ownerSetupWhy is missing/);
    expect((await row(t.id)).ownerSetup).toBeNull();
    textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Working.", ownerSetup: GOOD, ownerSetupWhy: "Frees slots.", ownerSetupIfSkipped: "Nothing breaks." } }));
    expect(await row(t.id)).toMatchObject({ ownerSetup: GOOD, ownerSetupWhy: "Frees slots.", ownerSetupIfSkipped: "Nothing breaks." });
  });

  it("the move to review refuses stored steps that have no why (a ticket written before the fields existed)", async () => {
    const c = await agentFor(ctx.dev.id);
    const t = await ctx.ticket({ ownerSetup: GOOD, ownerSetupWhy: null, ownerSetupIfSkipped: null });
    const out = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Built it. 1 pass: ok." } }));
    expect(out).toMatch(/ownerSetupWhy is missing/);
    expect((await row(t.id)).systemState).toBe("in_progress");
    // The fields alone can be set, with no steps resent.
    textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Added the lines.", ownerSetupWhy: "Frees slots.", ownerSetupIfSkipped: "Nothing breaks." } }));
    expect(await row(t.id)).toMatchObject({ ownerSetupWhy: "Frees slots.", ownerSetupIfSkipped: "Nothing breaks." });
  });

  it("update_ticket refuses new steps without why when the ticket has none stored", async () => {
    const c = await ceoAgent();
    const t = await ctx.ticket({ ownerSetupWhy: null, ownerSetupIfSkipped: null });
    expect(textOf(await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: GOOD, reason: "Steps." } }))).toMatch(/ownerSetupWhy is missing/);
    textOf(await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: GOOD, ownerSetupWhy: "Frees slots.", ownerSetupIfSkipped: "Nothing breaks.", reason: "Steps." } }));
    expect(await row(t.id)).toMatchObject({ ownerSetup: GOOD, ownerSetupWhy: "Frees slots." });
  });

  it("set_ticket_state ownerSetup refuses vague steps and stores nothing", async () => {
    const c = await agentFor(ctx.dev.id);
    const t = await ctx.ticket();
    const out = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Working.", ownerSetup: VAGUE } }));
    expect(out).toMatch(/can't go to the owner as written/);
    expect((await row(t.id)).ownerSetup).toBeNull();
  });

  it("update_ticket refuses vague steps", async () => {
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    const t = await ctx.ticket();
    const c = await agentFor(ctx.dev.id);
    const out = textOf(await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: VAGUE, reason: "Steps for the owner." } }));
    expect(out).toMatch(/can't go to the owner as written/);
    expect((await row(t.id)).ownerSetup).toBeNull();
  });

  it("the move to review checks the steps already stored (written before this check existed)", async () => {
    const c = await agentFor(ctx.dev.id);
    const t = await ctx.ticket({ ownerSetup: VAGUE });
    const out = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Built it." } }));
    expect(out).toMatch(/Step 1: names \.env/);
    expect(out).toMatch(/Fix them with set_ticket_state ownerSetup/);
    expect((await row(t.id)).systemState).toBe("in_progress");
  });

  it("lintOverride: a worker can't pass it; the CEO's is stored with the steps and cleared when they change without one", async () => {
    const t = await ctx.ticket();
    const worker = await agentFor(ctx.dev.id);
    expect(textOf(await worker.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "x", ownerSetup: "Restart the notifications add-on", lintOverride: "It restarts by itself after the update." } }))).toMatch(/Only the CEO can pass lintOverride/);
    const ceo = await ceoAgent();
    await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: "Restart the notifications add-on", lintOverride: "It restarts by itself after the update.", reason: "Steps for the owner." } });
    const stored = await row(t.id);
    expect(stored.ownerSetup).toBe("Restart the notifications add-on");
    expect(JSON.parse(stored.ownerSetupOverride!)).toEqual([{ steps: [1], rules: [expect.any(String)], reason: "It restarts by itself after the update." }]);
    await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: "Settings → Funding → Add funding source", reason: "Plainer steps." } });
    expect(await row(t.id)).toMatchObject({ ownerSetup: "Settings → Funding → Add funding source", ownerSetupOverride: null });
  });

  it("R35: update_ticket takes a list of overrides; a refused step it doesn't name stays refused, and a step edited later loses it", async () => {
    const t = await ctx.ticket();
    const ceo = await ceoAgent();
    const two = "Restart the notifications add-on\nSettings → Funding → Add funding source\nRestart the other add-on";
    const why = "Both add-ons restart by themselves.";
    expect(textOf(await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: two, lintOverride: [{ steps: [1], reason: why }], reason: "Steps for the owner." } }))).toMatch(/Step 3: [\s\S]*isn't covered/);
    expect((await row(t.id)).ownerSetup).not.toBe(two);
    await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: two, lintOverride: [{ steps: [1, 3], reason: why }], reason: "Steps for the owner." } });
    expect(JSON.parse((await row(t.id)).ownerSetupOverride!)).toEqual([{ steps: [1, 3], rules: [expect.any(String)], reason: why }]);
    // Step 3 is rewritten without a new override: the override is gone, so step 1 is refused again.
    expect(textOf(await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: "Restart the notifications add-on\nSettings → Funding → Add funding source\nRestart the third add-on", reason: "Edit." } }))).toMatch(/Step 1: /);
  });

  it("a merged ticket's steps stay frozen, except for the CEO while Boss Man's card to fix them is open", async () => {
    const t = await ctx.ticket({ ownerSetup: VAGUE, mergeCommit: "c".repeat(40), systemState: "done" });
    const c = await ceoAgent();
    expect(textOf(await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: GOOD, reason: "Fix the steps." } }))).toMatch(/merged, so its setup steps are frozen/);
    await ctx.db.insert(decisions).values({ companyId: ctx.co.company.id, kind: "question", question: "is live, but the setup steps can't go to the owner", options: ["Got it"], recommendedOption: "Got it", tier: "ceo", dedupeKey: `owner-setup-fix:${t.id}`, context: { type: "question", ticketId: t.id } });
    textOf(await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: GOOD, reason: "Fix the steps." } }));
    expect((await row(t.id)).ownerSetup).toBe(GOOD);
  });
});
