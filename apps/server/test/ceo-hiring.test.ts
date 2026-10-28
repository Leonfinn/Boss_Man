import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, fundingSources, notifications, projects, settings, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer", template: "engineer" })).json() as { id: string };
  const funding = (await req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, req, company, ceo, worker, funding, mcp };
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const setupArgs = (c: { funding: { id: string } }, extra: Record<string, unknown> = {}) => ({ harness: "claude", provider: "anthropic", model: "claude-opus-4-5", fundingSourceId: c.funding.id, reason: "Test hire.", ...extra });

describe("the CEO builds the team (R62)", () => {
  it("proposes a hire that waits for the owner, and is hired on approval with its history", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    const r = await client.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "Sam", template: "scrum-master", reason: "Someone should keep an eye on the checkout tickets." }) });
    expect(textOf(r)).toMatch(/waiting for the owner's approval \(decision /);
    expect(await c.db.select().from(agents).where(eq(agents.name, "Sam"))).toEqual([]);
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect(d).toMatchObject({ tier: "owner", options: ["Hire", "Don't hire"], recommendedOption: "Hire", raisedByAgentId: c.ceo.id });
    expect(d!.question).toContain("The CEO wants to hire Sam as Scrum Master.");
    expect(d!.question).toContain("Why: Someone should keep an eye");

    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Hire" })).statusCode).toBeLessThan(300);
    const [sam] = await c.db.select().from(agents).where(eq(agents.name, "Sam"));
    expect(sam).toMatchObject({ title: "Scrum Master", template: "scrum-master" });
    const history = (await c.req("GET", `/api/agents/${sam!.id}/history`)).json() as Array<{ c: { field: string; byAgentId: string } }>;
    expect(history[0]!.c).toMatchObject({ field: "hired", byAgentId: c.ceo.id });

    // Only the CEO hires; a bad template is refused with the list.
    const other = await c.mcp(c.worker.id);
    expect(await other.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "X", reason: "why not" }) })).toMatchObject({ isError: true });
    expect(textOf(await client.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "X", template: "pilot", reason: "r" }) }))).toContain("Templates: engineer");
    await client.close();
    await other.close();
  });

  it("always waits for the owner on a hire, even when nothing else needs approval", async () => {
    const c = (ctx = await setup());
    expect((await c.req("GET", `/api/companies/${c.company.id}/agent-approvals`)).json()).toEqual({ approvals: "hires" });
    await c.req("PUT", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "nothing" });
    const client = await c.mcp(c.ceo.id);
    const args = setupArgs(c, { name: "Quinn", template: "qa", reason: "Releases need testing." });
    expect(textOf(await client.callTool({ name: "propose_hire", arguments: args }))).toMatch(/waiting for the owner's approval/);
    expect(await c.db.select().from(agents).where(eq(agents.name, "Quinn"))).toEqual([]);
    await client.close();
    // The card carries all four model fields.
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect(d!.question).toContain("Harness: Claude Code · Provider: Anthropic · Model: claude-opus-4-5 · Paid from: Claude Max");
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Hire" })).statusCode).toBeLessThan(300);
    expect((await c.db.select().from(agents).where(eq(agents.name, "Quinn")))[0]).toMatchObject({ agentKind: "claude", model: "claude-opus-4-5", fundingSourceId: c.funding.id });
    expect((await c.db.select().from(notifications)).map((n) => n.title)).toEqual([]);
  });

  it("lists the valid model choices and refuses combinations the server can't run", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    const options = JSON.parse(textOf(await client.callTool({ name: "model_options", arguments: {} })));
    expect(options.harnesses).toEqual([{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }, { value: "opencode", label: "OpenCode" }]);
    expect(options.providers).toEqual(expect.arrayContaining([{ value: "anthropic", label: "Anthropic" }, { value: "ollama", label: "Ollama" }]));
    expect(options.fundingSources).toEqual([expect.objectContaining({ id: c.funding.id, name: "Claude Max", provider: "anthropic" })]);

    // An Ollama source can't run a Claude Code agent, and the provider must match the source.
    const ollama = (await c.req("POST", "/api/funding-sources", { name: "Ollama Cloud", kind: "subscription", provider: "ollama" })).json() as { id: string };
    expect(textOf(await client.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "A", harness: "claude", provider: "ollama", fundingSourceId: ollama.id, model: "qwen3:8b" }) }))).toContain("Claude Code can't run on Ollama");
    expect(textOf(await client.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "B", provider: "ollama" }) }))).toContain("pays with Anthropic, not Ollama");
    expect(textOf(await client.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "C", fundingSourceId: "not-a-uuid" }) }))).toContain("Invalid UUID");

    // A model list the runner reported is enforced for a real model ID.
    await c.db.insert(settings).values({ key: `models:${c.company.id}:opencode`, value: { models: [{ value: "ollama/qwen3:8b", name: "Qwen3" }], observedAt: new Date().toISOString() } });
    expect(textOf(await client.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "D", harness: "opencode", provider: "ollama", fundingSourceId: ollama.id, model: "ollama/unknown" }) }))).toContain("isn't in the list");
    expect(textOf(await client.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "D", harness: "opencode", provider: "ollama", fundingSourceId: ollama.id, model: "ollama/qwen3:8b" }) }))).toMatch(/waiting for the owner's approval/);
    await client.close();
  });

  it("proposes a model change for an existing agent and applies it only on the owner's say-so", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    const ollama = (await c.req("POST", "/api/funding-sources", { name: "Ollama Cloud", kind: "subscription", provider: "ollama" })).json() as { id: string };
    const change = { agent: "Engineer", harness: "opencode", provider: "ollama", model: "qwen3:8b", fundingSourceId: ollama.id, reason: "Cheaper for routine work." };
    expect(textOf(await client.callTool({ name: "propose_model_change", arguments: change }))).toMatch(/waiting for the owner/);
    const [d] = (await c.db.select().from(decisions)).filter((x) => (x.context as { type?: string }).type === "model_change");
    expect(d).toMatchObject({ options: ["Approve", "Edit", "Reject"], recommendedOption: "Approve" });
    // Nothing changes until the owner answers.
    expect((await c.db.select().from(agents).where(eq(agents.id, c.worker.id)))[0]).toMatchObject({ agentKind: "claude", model: null, fundingSourceId: null });
    expect(d!.question).toContain("Harness: Claude Code · Provider: not set · Model: default · Paid from: not set");
    expect(d!.question).toContain("Harness: OpenCode · Provider: Ollama · Model: qwen3:8b · Paid from: Ollama Cloud");

    // An edit is checked with the same rules: a Claude Code harness on Ollama is refused and the card stays open.
    const bad = await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Edit", modelConfig: { harness: "claude", provider: "ollama", model: "qwen3:8b", fundingSourceId: ollama.id } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toContain("Claude Code can't run on Ollama");
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!.status).toBe("open");

    // Reject changes nothing.
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Reject" })).statusCode).toBe(200);
    expect((await c.db.select().from(agents).where(eq(agents.id, c.worker.id)))[0]).toMatchObject({ agentKind: "claude", model: null, fundingSourceId: null });

    // A second proposal, approved, lands only between runs and says so.
    await client.callTool({ name: "propose_model_change", arguments: change });
    const open = (await c.db.select().from(decisions)).find((x) => x.status === "open" && (x.context as { type?: string }).type === "model_change")!;
    expect((await c.req("POST", `/api/decisions/${open.id}/answer`, { answer: "Approve" })).statusCode).toBe(200);
    expect((await c.db.select().from(agents).where(eq(agents.id, c.worker.id)))[0]).toMatchObject({ agentKind: "opencode", model: "qwen3:8b", fundingSourceId: ollama.id });
    const applied = (await c.db.select().from(decisions).where(eq(decisions.id, open.id)))[0]!;
    expect((applied.context as { applied?: { afterRunId: string | null; config?: unknown } }).applied).toMatchObject({ afterRunId: null, config: { harness: "opencode", provider: "ollama", model: "qwen3:8b", fundingSourceId: ollama.id } });
    await client.close();
  });

  it("auto-picks a source for a provider-only change, refuses a second open card, and records an edited config", async () => {
    const c = (ctx = await setup());
    await c.db.update(agents).set({ agentKind: "opencode", model: "claude-opus-4-5", fundingSourceId: c.funding.id }).where(eq(agents.id, c.worker.id));
    const ollama = (await c.req("POST", "/api/funding-sources", { name: "Ollama Cloud", kind: "subscription", provider: "ollama" })).json() as { id: string };
    const client = await c.mcp(c.ceo.id);
    const change = { agent: "Engineer", provider: "ollama", model: "qwen3:8b", reason: "Cheaper for routine work." };
    expect(textOf(await client.callTool({ name: "propose_model_change", arguments: change }))).toMatch(/waiting for the owner/);
    const [d] = (await c.db.select().from(decisions)).filter((x) => (x.context as { type?: string }).type === "model_change");
    expect((d!.context as { proposed: { fundingSourceId: string } }).proposed.fundingSourceId).toBe(ollama.id);
    // A second card for the same agent would be a race on one setting.
    expect(await client.callTool({ name: "propose_model_change", arguments: change })).toMatchObject({ isError: true });

    // Edit goes through the validator, and the card records the values that actually landed.
    const edited = { harness: "opencode", provider: "ollama", model: "qwen3:8b", fundingSourceId: ollama.id };
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Edit", modelConfig: edited })).statusCode).toBe(200);
    const after = (await c.db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!;
    expect((after.context as { applied?: { config?: unknown } }).applied?.config).toMatchObject(edited);
    expect((await c.db.select().from(agents).where(eq(agents.id, c.worker.id)))[0]).toMatchObject({ agentKind: "opencode", model: "qwen3:8b", fundingSourceId: ollama.id });
    await client.close();
  });

  it("changes instructions with a notification and undo, or waits when the owner approves edits too", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    // The CEO reads the current text before revising it; other agents can't.
    const read = textOf(await client.callTool({ name: "agent_instructions", arguments: { agent: "engineer" } }));
    expect(read).toMatch(/^# Engineer: Engineer \(hired from the engineer template\)/);
    expect(read).toContain("You build and fix software");
    const worker = await c.mcp(c.worker.id);
    expect(textOf(await worker.callTool({ name: "agent_instructions", arguments: { agent: "CEO" } }))).toBe("Only your company's CEO can read other agents' instructions.");
    await worker.close();
    expect(textOf(await client.callTool({ name: "update_instructions", arguments: { agent: "engineer", instructions: "Work only on the API.", reason: "The site is frozen." } }))).toContain("updated from their next run");
    const [eng] = await c.db.select().from(agents).where(eq(agents.id, c.worker.id));
    expect(eng!.instructions).toBe("Work only on the API.");
    expect((await c.db.select().from(notifications)).map((n) => n.title)).toContain("The CEO changed Engineer's instructions");
    const change = ((await c.req("GET", `/api/agents/${c.worker.id}/history`)).json() as Array<{ c: { id: string; field: string; byAgentId: string } }>).find((h) => h.c.field === "instructions")!;
    expect(change.c.byAgentId).toBe(c.ceo.id);
    expect((await c.req("POST", `/api/agent-changes/${change.c.id}/undo`)).json().instructions).toContain("You build and fix software");

    await c.req("PUT", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "hires_and_edits" });
    expect(textOf(await client.callTool({ name: "update_instructions", arguments: { agent: "Engineer", instructions: "Pair with QA.", reason: "Fewer bugs." } }))).toContain("waiting for the owner's approval");
    // A long change: the card's question holds the start, the queue carries all of it for the owner to read.
    const long = `Pair with QA.\n${"x".repeat(5000)}`;
    await client.callTool({ name: "update_instructions", arguments: { agent: "Engineer", instructions: long, reason: "Longer." } });
    const queued = (await c.req("GET", "/api/decisions")).json() as Array<{ id: string; question: string; context: { instructions?: string } }>;
    const longOne = queued.find((q) => q.context.instructions === long)!;
    expect(longOne.question.length).toBeLessThan(long.length);
    await c.db.delete(decisions).where(eq(decisions.id, longOne.id));
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Apply the change" });
    expect((await c.db.select().from(agents).where(eq(agents.id, c.worker.id)))[0]!.instructions).toBe("Pair with QA.");
    expect(await client.callTool({ name: "update_instructions", arguments: { agent: "Nobody", instructions: "x", reason: "y" } })).toMatchObject({ isError: true });
    await client.close();
  });
});

describe("the CEO assigns tickets, including to a planned hire", () => {
  const make = async (c: Awaited<ReturnType<typeof setup>>, title: string, assigneeAgentId?: string) => {
    const [pr] = await c.db.select().from(projects).where(eq(projects.companyId, c.company.id));
    const p = pr ?? (await c.db.insert(projects).values({ companyId: c.company.id, name: "App" }).returning())[0]!;
    await c.db.insert(tickets).values({ companyId: c.company.id, projectId: p.id, title, systemState: "ready", assigneeAgentId: assigneeAgentId ?? null });
  };
  const ticketOf = async (c: Awaited<ReturnType<typeof setup>>, title: string) => {
    const [t] = await c.db.select().from(tickets).where(eq(tickets.title, title));
    return t!;
  };

  it("sets and clears a ticket's assignee with a reason in the activity log, for managers only", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    await make(c, "Fix login");
    const t = await ticketOf(c, "Fix login");
    expect(t.assigneeAgentId).toBeNull();

    const set = await client.callTool({ name: "update_ticket", arguments: { ticketId: t.id, assignee: "Engineer", reason: "Engineer owns the login code" } });
    expect(set).not.toHaveProperty("isError", true);
    expect((await ticketOf(c, "Fix login")).assigneeAgentId).toBe(c.worker.id);
    let log = (await c.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((a) => a.summary);
    expect(log).toContain("Assigned to Engineer");
    expect(log.some((s) => s.includes("Engineer owns the login code"))).toBe(true);

    expect(await client.callTool({ name: "update_ticket", arguments: { ticketId: t.id, assignee: "Nobody Here", reason: "r" } })).toMatchObject({ isError: true });

    await client.callTool({ name: "update_ticket", arguments: { ticketId: t.id, assignee: null, reason: "Reassigning later" } });
    expect((await ticketOf(c, "Fix login")).assigneeAgentId).toBeNull();
    log = (await c.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((a) => a.summary);
    expect(log).toContain("Assigned to nobody");

    const other = await c.mcp(c.worker.id);
    expect(await other.callTool({ name: "update_ticket", arguments: { ticketId: t.id, assignee: "Engineer", reason: "r" } })).toMatchObject({ isError: true });
    await other.close();
    await client.close();
  });

  it("assigns tickets planned for a hire when the owner approves it, and leaves taken ones alone", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    await make(c, "Design the filter bar");
    await make(c, "Already taken", c.worker.id);
    const planned = await ticketOf(c, "Design the filter bar");
    const taken = await ticketOf(c, "Already taken");

    expect(await client.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "Dee", template: "scrum-master", reason: "r", forTickets: [randomUUID()] }) })).toMatchObject({ isError: true });
    const r = await client.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "Dee", template: "scrum-master", reason: "Needs a designer", forTickets: [planned.id, taken.id] }) });
    expect(textOf(r)).toMatch(/waiting for the owner's approval/);
    expect((await ticketOf(c, "Design the filter bar")).assigneeAgentId).toBeNull();

    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Hire" })).statusCode).toBeLessThan(300);
    const [dee] = await c.db.select().from(agents).where(eq(agents.name, "Dee"));
    expect((await ticketOf(c, "Design the filter bar")).assigneeAgentId).toBe(dee!.id);
    expect((await ticketOf(c, "Already taken")).assigneeAgentId).toBe(c.worker.id);
    await client.close();
  });

  it("keeps a hire card open when its setup no longer checks out, and hires nobody", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    await client.callTool({ name: "propose_hire", arguments: setupArgs(c, { name: "Rae", template: "qa", reason: "Releases need testing." }) });
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    // The funding source it was checked against is gone by the time the owner answers.
    await c.db.delete(fundingSources).where(eq(fundingSources.id, c.funding.id));
    const failed = await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Hire" });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().message).toContain("No funding source with that ID");
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!.status).toBe("open");
    expect(await c.db.select().from(agents).where(eq(agents.name, "Rae"))).toEqual([]);

    // A card raised before hires carried the four fields is reopened, not closed with nobody hired.
    const [legacy] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        raisedByAgentId: c.ceo.id,
        kind: "approval",
        tier: "owner",
        question: "The CEO wants to hire Old.",
        options: ["Hire", "Don't hire"],
        recommendedOption: "Hire",
        context: { type: "hire", proposal: { name: "Old", template: "qa", model: "claude-opus-4-5", fundingSourceId: c.funding.id }, byAgentId: c.ceo.id },
      })
      .returning({ id: decisions.id });
    const stale = await c.req("POST", `/api/decisions/${legacy!.id}/answer`, { answer: "Hire" });
    expect(stale.statusCode).toBe(422);
    expect(stale.json().message).toContain("Choose a harness");
    expect((await c.db.select().from(decisions).where(eq(decisions.id, legacy!.id)))[0]!.status).toBe("open");
    expect(await c.db.select().from(agents).where(eq(agents.name, "Old"))).toEqual([]);
    await client.close();
  });
});
