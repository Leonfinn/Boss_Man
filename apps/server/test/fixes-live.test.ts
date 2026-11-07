// BOS-639: the "fixes live" marker on a ticket. Set by hand (the CEO when filing, the author or a reviewer),
// shown to reviewers like DR-011's owner steps, and the CEO is woken when a marked ticket merges.
// The deploy card side (heading, page once, sort first) is in self-deploy.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, companies, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { fixesLiveHeading } from "../src/services/decisions.js";

const EMPTY: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "a".repeat(40), commits: [], files: [], diff: "", truncated: false };
const SYMPTOM = "server freezes as memory climbs";

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
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  await db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co.company.id));
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, (command) => {
    const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (command as { requestId: string }).requestId, ok: true, data }));
    if (command.type === "workspace.diff") ok({ ...EMPTY, head: "b".repeat(40), files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff" });
    if (command.type === "workspace.verify") ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
    if (command.type === "workspace.merge") ok({ status: "merged", commit: "c".repeat(40) });
    if (command.type === "workspace.carried") ok({ carried: [] });
    if (command.type === "workspace.migrations") ok({ needed: false, reason: "Nothing taken." });
    return true;
  });
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Server memory fix", number: 410, systemState: "in_progress", assigneeAgentId: dev.id, branch: "bossman/x", ...patch }).returning())[0]!;
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

describe("the \"fixes live\" marker (BOS-639)", () => {
  it("the CEO sets it when filing a ticket with create_ticket", async () => {
    const c = await agentFor(ctx.co.ceo.id);
    const out = textOf(await c.callTool({ name: "create_ticket", arguments: { size: 3, project: "Customer app", title: "Memory fix", fixesLive: SYMPTOM } }));
    const id = /([0-9a-f-]{36})/.exec(out)![1]!;
    expect((await row(id)).fixesLive).toBe(SYMPTOM);
  });

  it("is one short sentence: several lines or a long text are refused", async () => {
    const c = await agentFor(ctx.co.ceo.id);
    const multi = await c.callTool({ name: "create_ticket", arguments: { size: 3, project: "Customer app", title: "Memory fix", fixesLive: "server freezes\nand memory climbs" } });
    expect((multi as { isError?: boolean }).isError).toBe(true);
    expect(textOf(multi)).toMatch(/one line/);
    const t = await ctx.ticket();
    const long = await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, fixesLive: "x".repeat(201), reason: "Too long." } });
    expect((long as { isError?: boolean }).isError).toBe(true);
    expect((await row(t.id)).fixesLive).toBeNull();
  });

  it("the author sets it with set_ticket_state; another worker can't", async () => {
    const t = await ctx.ticket();
    const other = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/agents`, { name: "Someone else" })).json() as { id: string };
    const stranger = await agentFor(other.id);
    expect(textOf(await stranger.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "x", fixesLive: SYMPTOM } }))).toMatch(/isn't yours/);
    expect((await row(t.id)).fixesLive).toBeNull();
    const author = await agentFor(ctx.dev.id);
    await author.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Working on it.", fixesLive: SYMPTOM } });
    expect((await row(t.id)).fixesLive).toBe(SYMPTOM);
    // An empty string clears it.
    await author.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Not live after all.", fixesLive: "" } });
    expect((await row(t.id)).fixesLive).toBeNull();
  });

  it("a manager sets and clears it with update_ticket", async () => {
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    const t = await ctx.ticket({ assigneeAgentId: null });
    const c = await agentFor(ctx.dev.id);
    await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, fixesLive: SYMPTOM, reason: "Incident fix." } });
    expect((await row(t.id)).fixesLive).toBe(SYMPTOM);
    await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, fixesLive: null, reason: "Not live." } });
    expect((await row(t.id)).fixesLive).toBeNull();
  });

  it("reviewers see it in the ticket and the diff, and the reviewer can add it with submit", async () => {
    const t = await ctx.ticket({ systemState: "review" });
    const ceo = await agentFor(ctx.co.ceo.id);
    // Not marked yet: nothing shown.
    expect(textOf(await ceo.callTool({ name: "review", arguments: { action: "diff", ticketId: t.id } }))).not.toContain("Fixes live");
    const sent = textOf(await ceo.callTool({ name: "review", arguments: { action: "submit", ticketId: t.id, verdict: "changes_requested", summary: "Needs a test.", fixesLive: SYMPTOM } }));
    expect(sent).not.toMatch(/Only your company's CEO/);
    expect((await row(t.id)).fixesLive).toBe(SYMPTOM);
    const diff = textOf(await ceo.callTool({ name: "review", arguments: { action: "diff", ticketId: t.id } }));
    expect(diff).toContain(`Fixes live: ${SYMPTOM}`);
    const read = textOf(await ceo.callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id } }));
    expect(read).toContain("## Fixes live");
    expect(read).toContain(SYMPTOM);
  });

  it("wakes the CEO at merge with the deploy card's heading", { timeout: 120_000 }, async () => {
    const t = await ctx.ticket({ systemState: "review", branch: undefined, fixesLive: `${SYMPTOM}.` });
    await ctx.db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
    const r = await ctx.review.landVisible(t.id, "the owner");
    expect(r.outcome).toBe("merged");
    const note = (await ctx.db.select().from(wakes)).filter((w) => w.agentId === ctx.co.ceo.id && w.reason === "fixes live merged").at(-1)?.note ?? "";
    expect(note).toContain(`Urgent: contains the fix for ${SYMPTOM} (BOS-410).`);
    expect(note).toContain("never deploys by itself");
  });

  it("an unmarked ticket's merge doesn't wake the CEO about it", { timeout: 120_000 }, async () => {
    // Urgent, but not marked: the marker is never guessed from urgency or priority.
    const t = await ctx.ticket({ systemState: "review", urgent: true });
    await ctx.db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
    expect((await ctx.review.landVisible(t.id, "the owner")).outcome).toBe("merged");
    expect((await ctx.db.select().from(wakes)).filter((w) => w.reason === "fixes live merged")).toEqual([]);
  });

  it("names every marked fix in one heading", () => {
    expect(fixesLiveHeading([{ symptom: "server freezes. ", ref: "BOS-410" }, { symptom: "board is blank", ref: "BOS-411" }])).toBe("Urgent: contains the fix for server freezes (BOS-410); also board is blank (BOS-411)");
  });
});
