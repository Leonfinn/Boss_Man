// "On a real host" criteria (DR-024 #5): a check only the live host can settle must not bounce rounds of
// review. Each test here fails on the old code and passes with the after-merge mark.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REVIEW_POLICY, afterMergeLint, isAfterMerge, missingVerdicts, readVerdicts, unreportedAfterMerge } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, reviewRequests, runners, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { landingText } from "../src/services/review.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = async (patch: Record<string, unknown> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Rate limiting", systemState: "in_progress", ...patch }).returning())[0]!;
  const agent = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return {
    ...built,
    db,
    close,
    req,
    co,
    dev,
    project,
    ticket,
    agent,
    row: async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!,
    done: async () => {
      await Promise.all(clients.map((c) => c.close()));
      await built.app.close();
      await close();
    },
  };
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

const BEFORE = "Health check returns 200";
const LIVE = { text: "Answers from the owner's Tailscale name on a real host", after: "merge" as const };

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.done();
});

describe("after-merge criteria", () => {
  it("tells the two kinds apart and reads verdicts by the criterion's words", () => {
    expect(isAfterMerge(LIVE)).toBe(true);
    expect(isAfterMerge(BEFORE)).toBe(false);
    const rows = readVerdicts([BEFORE, LIVE], "Health check returns 200 pass");
    expect(rows.map((r) => r.verdict)).toEqual(["pass", null]);
    expect(missingVerdicts([BEFORE, LIVE], "Health check returns 200 pass")).toEqual([LIVE.text]);
    expect(missingVerdicts([BEFORE, LIVE], "Health check returns 200 pass", "before")).toEqual([]);
    expect(unreportedAfterMerge([BEFORE, LIVE], `Health check returns 200 pass. ${LIVE.text} pass.`)).toEqual([]);
    expect(unreportedAfterMerge([BEFORE, LIVE], "Health check returns 200 pass")).toEqual([LIVE.text]);
  });

  it("warns, without refusing, when a criterion reads like a live check but isn't marked after merge", () => {
    const warned = afterMergeLint([BEFORE, "The owner confirms it on a real host"]);
    expect(warned).toContain("on a real host");
    expect(warned).toMatch(/warning only/i);
    expect(afterMergeLint([BEFORE, "The owner confirms it on a real host", { text: "Checked after this merge", after: "merge" }])).toBe(warned);
    expect(afterMergeLint([BEFORE])).toBe("");
    // The marked one itself is not warned about.
    expect(afterMergeLint([{ text: "The owner confirms it on a real host", after: "merge" }])).toBe("");
  });

  it("create_ticket takes both kinds and returns the warn-lint, never refusing", async () => {
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "create_ticket", arguments: { size: 2, project: "Customer app", title: "With a live check", acceptanceCriteria: [BEFORE, "Works from the owner's Tailscale name on a real host"] } });
    const t = textOf(r);
    expect(t).toMatch(/Created ticket/);
    expect(t).toContain("on a real host");
    expect(t).toContain("warning only");
    const [created] = await ctx.db.select().from(tickets).where(eq(tickets.title, "With a live check"));
    expect(created!.acceptanceCriteria).toEqual([BEFORE, "Works from the owner's Tailscale name on a real host"]);
  });

  it("the owner's API takes the after-merge shape and gives it back unchanged", async () => {
    const made = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Owner made", acceptanceCriteria: [BEFORE, LIVE] })).json() as { id: string; acceptanceCriteria: unknown };
    expect(made.acceptanceCriteria).toEqual([BEFORE, LIVE]);
  });

  it("review can be entered with the after-merge criterion unreported, and its wake note marks it skippable", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, LIVE] });
    const c = await ctx.agent(ctx.dev.id);
    await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Health check returns 200 pass; tests pass." } });
    expect((await ctx.row(t.id)).systemState).toBe("review");
    const note = (await ctx.db.select().from(wakes)).filter((w) => w.agentId === ctx.co.ceo.id && w.reason === "review requested").at(-1)?.note ?? "";
    expect(note).toContain("[not reported]");
    expect(note).toContain("checked after merge");
    expect(note).toMatch(/approve with the after-merge ones still unreported/);
  });

  it("still refuses review while a before-merge criterion is unreported", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, LIVE] });
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Tests pass." } });
    expect(textOf(r)).toContain("Health check returns 200");
    expect(textOf(r)).not.toContain(LIVE.text);
    expect((await ctx.row(t.id)).systemState).toBe("in_progress");
  });

  it("won't close a merged ticket until the after-merge criterion is reported", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, LIVE], systemState: "review", mergeCommit: "d".repeat(40), stateNote: "Health check returns 200 pass" });
    const c = await ctx.agent(ctx.dev.id);
    const refused = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Merged; all good." } });
    expect(textOf(refused)).toContain(LIVE.text);
    expect((await ctx.row(t.id)).systemState).toBe("review");
    const good = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: `Merged. ${LIVE.text} pass.` } });
    expect(textOf(good)).toContain("is now done");
    expect((await ctx.row(t.id)).systemState).toBe("done");
  });

  it("a merge with an after-merge criterion sends the ticket back to show it, and plain words say why", { timeout: 120_000 }, async () => {
    const { db, req, co, dev, project } = ctx;
    await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
    const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
    const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
    ctx.runners.connect(reg.runnerId, (command) => {
      const ok = (data: unknown) => queueMicrotask(() => ctx.runners.resolveReply({ requestId: (command as { requestId: string }).requestId, ok: true, data }));
      if (command.type === "workspace.verify") ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
      if (command.type === "workspace.merge") ok({ status: "merged", commit: "c".repeat(40) });
      if (command.type === "workspace.carried") ok({ carried: [] });
      if (command.type === "workspace.migrations") ok({ needed: false, reason: "No other branch uses this ticket's migration numbers." });
      return true;
    });
    void runner;
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Live check", assigneeAgentId: dev.id, acceptanceCriteria: [BEFORE, LIVE] })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, stateNote: "Health check returns 200 pass" }).where(eq(tickets.id, t.id));
    await db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    const r = await ctx.review.landVisible(t.id, "the owner");
    expect(r.outcome).toBe("merged");
    expect((r.detail as { afterMerge?: string[] }).afterMerge).toEqual([LIVE.text]);
    const after = await ctx.row(t.id);
    // Back with its assignee, with its working copy kept so the live check can be shown where it was.
    expect(after.systemState).toBe("in_progress");
    expect(after.mergeCommit).toBe("c".repeat(40));
    expect(after.noCode).toBe(true);
    const note = (await db.select().from(wakes)).filter((w) => w.agentId === dev.id && w.reason === "after merge").at(-1)?.note ?? "";
    expect(note).toContain(LIVE.text);
    // The page's plain words tell the owner the ticket stays open for the live check.
    const words = landingText(r, { branch: "main", assignee: "Dev" });
    expect(words).toContain("stays open");
    expect(words).toContain(LIVE.text);
  });

  it("a merge with only before-merge criteria closes the ticket as it always did", async () => {
    expect(landingText({ outcome: "merged" }, { branch: "main", assignee: "Dev" })).toBe("Merged into main.");
  });

  it("the diff checklist a reviewer reads separates the two kinds", async () => {
    const { db, req, co, dev, project } = ctx;
    await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
    const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
    ctx.runners.connect(reg.runnerId, (command) => {
      if (command.type === "workspace.diff") queueMicrotask(() => ctx.runners.resolveReply({ requestId: (command as { requestId: string }).requestId, ok: true, data: { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [], files: [], diff: "", truncated: false } }));
      return true;
    });
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Live check 2", assigneeAgentId: dev.id, acceptanceCriteria: [BEFORE, LIVE] })).json() as { id: string };
    // The CEO reviews its own company's work unless the policy names another; give it the review.
    await db.update(tickets).set({ stateNote: "Health check returns 200 pass" }).where(eq(tickets.id, t.id));
    await db.insert(reviewRequests).values({ ticketId: t.id, round: 1, kind: "code", reviewerAgentId: co.ceo.id, status: "pending" });
    const ceoC = await ctx.agent(co.ceo.id);
    const seen = textOf(await ceoC.callTool({ name: "review", arguments: { ticketId: t.id, action: "diff" } }));
    expect(seen).toContain("checked after merge");
    expect(seen).toMatch(/before-merge/);
    expect(DEFAULT_REVIEW_POLICY.medium.reviewer).toBeTruthy();
  });
});
