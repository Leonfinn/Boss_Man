import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Journal, RunnerConnection } from "@boss-man/runner";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, engagements, policyRules, projects, runners, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

async function waitFor<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, heartbeatMs: 200 });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const mk = async (name: string) => (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name } })).json() as { company: { id: string }; ceo: { id: string } };
  const appCo = await mk("App Co");
  const homelab = await mk("Homelab Co");
  return { ...built, db, close, base, cookie, appCo, homelab };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

describe("permission requests through the policy engine", () => {
  it("re-sends verdicts lost in a dropped connection, for requests the runner is still waiting on", async () => {
    const reg = (await ctx.app.inject({ method: "POST", url: `/api/companies/${ctx.homelab.company.id}/runner`, headers: { cookie: ctx.cookie } })).json();
    const runId = randomUUID();
    const waiting = new Set<string>();
    const got: RunnerCommand[] = [];
    let dropNext = false;
    const conn = new RunnerConnection({
      url: `ws://${ctx.base}/api/runner/connect`,
      token: reg.token,
      journal: new Journal(path.join(mkdtempSync(path.join(tmpdir(), "bm-")), "j.jsonl")),
      runnerVersion: "test",
      heartbeatMs: 200,
      // Stands in for a verdict that was written to a socket just before it died.
      onCommand: (c) => {
        if (c.type !== "permission.decide") return;
        if (dropNext) return void (dropNext = false);
        waiting.delete(c.requestId);
        got.push(c);
      },
      pendingPermissions: () => [...waiting].map((requestId) => ({ runId, requestId })),
    });
    conn.start();
    try {
      await waitFor(() => conn.isLive, Boolean);
      conn.emit({ type: "run.started", runId, agentId: ctx.homelab.ceo.id, acpSessionId: "s", model: null });

      // A policy verdict, lost.
      dropNext = true;
      waiting.add("r1");
      conn.emit({ type: "run.permission_request", runId, requestId: "r1", title: "echo hi", kind: "execute", rawInput: { command: "echo hi" }, optionKinds: ["allow_once", "reject_once"] });
      await waitFor(() => dropNext, (v) => v === false);
      expect(got).toEqual([]);
      conn.breakConnection();
      await waitFor(() => got.length, (n) => n === 1);
      expect(got[0]).toEqual({ type: "permission.decide", runId, requestId: "r1", verdict: "allow" });

      // The owner's answer, lost.
      waiting.add("r2");
      conn.emit({ type: "run.permission_request", runId, requestId: "r2", title: "rm -rf /tmp/x", kind: "execute", rawInput: { command: "rm -rf /tmp/x" }, optionKinds: ["allow_once", "reject_once"] });
      const [d] = await waitFor(async () => (await ctx.app.inject({ method: "GET", url: "/api/decisions", headers: { cookie: ctx.cookie } })).json() as Array<{ id: string; recommendedOption: string }>, (x) => x.length === 1);
      dropNext = true;
      await ctx.app.inject({ method: "POST", url: `/api/decisions/${d!.id}/answer`, headers: { cookie: ctx.cookie }, payload: { answer: d!.recommendedOption } });
      await waitFor(() => dropNext, (v) => v === false);
      conn.breakConnection();
      await waitFor(() => got.length, (n) => n === 2);
      expect(got[1]).toEqual({ type: "permission.decide", runId, requestId: "r2", verdict: "deny" });
      expect(waiting.size).toBe(0);
    } finally {
      conn.stop();
    }
  });

  it("auto-answers routine requests and queues destructive ones for the owner", async () => {
    const reg = (await ctx.app.inject({ method: "POST", url: `/api/companies/${ctx.homelab.company.id}/runner`, headers: { cookie: ctx.cookie } })).json();
    await ctx.db.insert(policyRules).values({ companyId: ctx.homelab.company.id, name: "Homelab may restart containers", trigger: "permission", condition: { commandPattern: "^docker\\s+restart\\b" }, outcome: "allow" });

    const commands: RunnerCommand[] = [];
    const runId = randomUUID();
    // Like a real runner, it says which requests it is still waiting on when it reconnects.
    const waiting = new Set<string>();
    const conn = new RunnerConnection({
      url: `ws://${ctx.base}/api/runner/connect`,
      token: reg.token,
      journal: new Journal(path.join(mkdtempSync(path.join(tmpdir(), "bm-")), "j.jsonl")),
      runnerVersion: "test",
      heartbeatMs: 200,
      onCommand: (c) => {
        if (c.type === "addons.check") return; // asked of every runner at connect (docs/12)
        if (c.type === "permission.decide") {
          if (!waiting.delete(c.requestId)) return;
        }
        commands.push(c);
      },
      pendingPermissions: () => [...waiting].map((requestId) => ({ runId, requestId })),
    });
    conn.start();
    await waitFor(() => conn.isLive, Boolean);

    conn.emit({ type: "run.started", runId, agentId: ctx.homelab.ceo.id, acpSessionId: "s", model: null });
    const ask = (requestId: string, command: string) => {
      waiting.add(requestId);
      conn.emit({ type: "run.permission_request", runId, requestId, title: command, kind: "execute", rawInput: { command }, optionKinds: ["allow_once", "reject_once"] });
    };

    ask("r1", "echo hello");
    ask("r2", "docker restart web");
    ask("r3", "rm -rf /mnt/tank/apps");
    await waitFor(() => commands.length, (n) => n === 2);
    expect(commands).toEqual([
      { type: "permission.decide", runId, requestId: "r1", verdict: "allow" },
      { type: "permission.decide", runId, requestId: "r2", verdict: "allow" },
    ]);

    const open = await waitFor(async () => (await ctx.app.inject({ method: "GET", url: "/api/decisions", headers: { cookie: ctx.cookie } })).json() as Array<{ id: string; question: string; recommendedOption: string; tier: string }>, (d) => d.length === 1);
    expect(open[0]).toMatchObject({ question: expect.stringMatching(/^CEO wants to run a command\. Deletes files/), recommendedOption: "Deny", tier: "owner" });

    const bad = await ctx.app.inject({ method: "POST", url: `/api/decisions/${open[0]!.id}/answer`, headers: { cookie: ctx.cookie }, payload: { answer: "Maybe" } });
    expect(bad.statusCode).toBe(422);
    const ans = await ctx.app.inject({ method: "POST", url: `/api/decisions/${open[0]!.id}/answer`, headers: { cookie: ctx.cookie }, payload: { answer: "Deny" } });
    expect(ans.json()).toMatchObject({ delivered: true });
    await waitFor(() => commands.length, (n) => n === 3);
    expect(commands[2]).toEqual({ type: "permission.decide", runId, requestId: "r3", verdict: "deny" });
    conn.stop();
  });
  it("Allow always answers the request and saves a rule, so the next identical request skips the owner", async () => {
    const reg = (await ctx.app.inject({ method: "POST", url: `/api/companies/${ctx.homelab.company.id}/runner`, headers: { cookie: ctx.cookie } })).json();
    const commands: RunnerCommand[] = [];
    const runId = randomUUID();
    const conn = new RunnerConnection({
      url: `ws://${ctx.base}/api/runner/connect`,
      token: reg.token,
      journal: new Journal(path.join(mkdtempSync(path.join(tmpdir(), "bm-")), "j.jsonl")),
      runnerVersion: "test",
      heartbeatMs: 200,
      onCommand: (c) => c.type !== "addons.check" && commands.push(c),
      pendingPermissions: () => [],
    });
    conn.start();
    await waitFor(() => conn.isLive, Boolean);
    conn.emit({ type: "run.started", runId, agentId: ctx.homelab.ceo.id, acpSessionId: "s", model: null });
    const ask = (requestId: string, title: string, command?: string) =>
      conn.emit({ type: "run.permission_request", runId, requestId, title, kind: command ? "execute" : "other", rawInput: command ? { command } : { url: "https://x.dev" }, optionKinds: ["allow_once", "reject_once"] });
    const open = async (n: number) => waitFor(async () => (await ctx.app.inject({ method: "GET", url: "/api/decisions", headers: { cookie: ctx.cookie } })).json() as Array<{ id: string; question: string; options: string[] }>, (d) => d.length === n);

    // The owner's own deny rule must keep winning over any "always" rule made later.
    await ctx.db.insert(policyRules).values({ companyId: ctx.homelab.company.id, name: "No crawl4ai JS", trigger: "permission", condition: { titlePattern: "^mcp__crawl4ai__execute_js$" }, outcome: "deny", position: 0 });
    ask("r1", "mcp__crawl4ai__md");
    const [d] = await open(1);
    expect(d!.options).toEqual(["Allow once", "Always allow crawl4ai's md tool", "Always allow every crawl4ai tool", "Deny"]);
    expect(d!.question).toMatch(/^CEO wants to use a tool/);
    const ans = await ctx.app.inject({ method: "POST", url: `/api/decisions/${d!.id}/answer`, headers: { cookie: ctx.cookie }, payload: { answer: "Always allow crawl4ai's md tool" } });
    expect(ans.json()).toMatchObject({ delivered: true });
    await waitFor(() => commands.length, (n) => n === 1);
    expect(commands[0]).toEqual({ type: "permission.decide", runId, requestId: "r1", verdict: "allow" });
    const rules = await ctx.db.select().from(policyRules).where(eq(policyRules.companyId, ctx.homelab.company.id)).orderBy(policyRules.position);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ name: "No crawl4ai JS", position: 0 });
    expect(rules[1]).toMatchObject({ outcome: "allow", position: 1, condition: { titlePattern: "^mcp__crawl4ai__md$", safeOnly: true } });
    expect(rules[1]!.name).toMatch(/^Allow crawl4ai's md tool \(from a request on \d+ \w+\)$/);

    ask("r2", "mcp__crawl4ai__md");
    await waitFor(() => commands.length, (n) => n === 2);
    expect(commands[1]).toEqual({ type: "permission.decide", runId, requestId: "r2", verdict: "allow" });
    // A different tool of the same server still asks; a command that needs the owner gets no "always".
    ask("r3", "mcp__crawl4ai__crawl");
    ask("r4", "rm -rf dist", "rm -rf dist");
    const all = await open(2);
    expect(all.find((x) => x.question.includes("Deletes files"))!.options).toEqual(["Allow once", "Deny"]);
    conn.stop();
  });
  it("keeps a policy verdict the runner missed and sends it when the runner reconnects (R22)", async () => {
    const reg = (await ctx.app.inject({ method: "POST", url: `/api/companies/${ctx.homelab.company.id}/runner`, headers: { cookie: ctx.cookie } })).json();
    const [runner] = await ctx.db.select().from(runners).where(eq(runners.id, reg.runnerId));
    const runId = randomUUID();
    // The socket has just gone: nothing can be sent.
    const drop = ctx.runners.connect(runner!.id, () => false);
    await ctx.runners.ingest(runner!, { seq: 1, at: new Date().toISOString(), event: { type: "run.started", runId, agentId: ctx.homelab.ceo.id, acpSessionId: "s", model: null } });
    await ctx.runners.ingest(runner!, { seq: 2, at: new Date().toISOString(), event: { type: "run.permission_request", runId, requestId: "r1", title: "echo hi", kind: "execute", rawInput: { command: "echo hi" }, optionKinds: ["allow_once"] } });
    drop();
    // The open queue stays clean: this was the policy's call, not the owner's.
    expect((await ctx.app.inject({ method: "GET", url: "/api/decisions", headers: { cookie: ctx.cookie } })).json()).toEqual([]);

    const commands: RunnerCommand[] = [];
    ctx.runners.connect(runner!.id, (c) => (commands.push(c), true));
    await waitFor(() => commands.length, (n) => n === 1);
    expect(commands[0]).toEqual({ type: "permission.decide", runId, requestId: "r1", verdict: "allow" });
  });
});

describe("Boss Man MCP server", () => {
  async function client(companyId: string, agentId: string) {
    const token = await issueRunToken(ctx.db, { companyId, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  }
  const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

  it("refuses requests without a valid run token", async () => {
    const res = await fetch(`http://${ctx.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("exposes a small, described tool set", async () => {
    const c = await client(ctx.appCo.company.id, ctx.appCo.ceo.id);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["assign_ticket", "clear_check", "create_ticket", "decisions", "deploy", "engagement", "feedback", "handoff", "list_my_work", "notify_owner", "nudge", "pa_verdict", "propose_hire", "propose_rule", "raise_decision", "report_key_result", "request_engagement", "review", "runs", "schedule_check", "set_ticket_risk", "set_ticket_state", "skills", "ticket_reply", "tickets", "update_instructions", "whats_new", "wiki"]);
    expect(tools.every((t) => (t.description ?? "").length > 20)).toBe(true);
    expect(tools.find((t) => t.name === "ticket_reply")!.description).toContain("Details:");
    expect(tools.find((t) => t.name === "set_ticket_state")!.description).toContain("plain words");
    await c.close();
  });

  it("creates tickets in the agent's own company only", async () => {
    const c = await client(ctx.appCo.company.id, ctx.appCo.ceo.id);
    const none = await c.callTool({ name: "create_ticket", arguments: { title: "Set up CI" } });
    expect(none.isError).toBe(true);
    await ctx.db.insert(projects).values({ companyId: ctx.appCo.company.id, name: "Customer app" });
    const ok = await c.callTool({ name: "create_ticket", arguments: { title: "Set up CI" } });
    expect(textOf(ok)).toMatch(/Created ticket .* in Customer app/);

    // A Homelab Co ticket is invisible to App Co's agent.
    const [hp] = await ctx.db.insert(projects).values({ companyId: ctx.homelab.company.id, name: "Ops" }).returning();
    const [ht] = await ctx.db.insert(tickets).values({ companyId: ctx.homelab.company.id, projectId: hp!.id, title: "Patch TrueNAS" }).returning();
    const cross = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: ht!.id, state: "done", summary: "Done." } });
    expect(cross.isError).toBe(true);
    const [still] = await ctx.db.select().from(tickets).where(eq(tickets.id, ht!.id));
    expect(still!.systemState).toBe("backlog");
    await c.close();
  });

  it("won't let an agent mark a repo ticket done; it goes through review and merge (R46)", async () => {
    const [p] = await ctx.db.insert(projects).values({ companyId: ctx.appCo.company.id, name: "Customer app", repoUrl: "https://github.com/Leonfinn/customer-app.git" }).returning();
    const [t] = await ctx.db.insert(tickets).values({ companyId: ctx.appCo.company.id, projectId: p!.id, title: "Add rate limiting", systemState: "in_progress", branch: "bossman/x" }).returning();
    const c = await client(ctx.appCo.company.id, ctx.appCo.ceo.id);
    expect(textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t!.id, state: "done" } }))).toMatch(/move the ticket to "review" instead/);
    expect(textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t!.id, state: "review", summary: "Ready." } }))).toMatch(/now review/);
    expect(textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t!.id, state: "done", outcome: "cancelled", summary: "Dropped." } }))).toMatch(/now done/);
    await c.close();
  });

  it("raise_decision blocks a ticket until the owner answers", async () => {
    const [p] = await ctx.db.insert(projects).values({ companyId: ctx.appCo.company.id, name: "Customer app" }).returning();
    const [t] = await ctx.db.insert(tickets).values({ companyId: ctx.appCo.company.id, projectId: p!.id, title: "Pick DNS provider", systemState: "in_progress" }).returning();
    const c = await client(ctx.appCo.company.id, ctx.appCo.ceo.id);
    const noRec = await c.callTool({ name: "raise_decision", arguments: { question: "Which DNS?", options: ["Cloudflare", "deSEC"], recommended: "Route 53" } });
    expect(noRec.isError).toBe(true);
    await c.callTool({ name: "raise_decision", arguments: { question: "Which DNS provider?", options: ["Cloudflare", "deSEC"], recommended: "deSEC", blocksTicketId: t!.id } });
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t!.id)))[0]!.systemState).toBe("blocked");

    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "question"));
    expect(d).toMatchObject({ recommendedOption: "deSEC", raisedByAgentId: ctx.appCo.ceo.id });
    await ctx.app.inject({ method: "POST", url: `/api/decisions/${d!.id}/answer`, headers: { cookie: ctx.cookie }, payload: { answer: "deSEC" } });
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t!.id)))[0]!.systemState).toBe("ready");
    await c.close();
  });

  it("lets the owner answer an agent's question in their own words, and only a question", async () => {
    const c = await client(ctx.appCo.company.id, ctx.appCo.ceo.id);
    await c.callTool({ name: "raise_decision", arguments: { question: "Which of C1-C6 should become tickets?", options: ["C1, C2 and C4", "All six"], recommended: "C1, C2 and C4" } });
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "question"));
    const answer = (payload: object) => ctx.app.inject({ method: "POST", url: `/api/decisions/${d!.id}/answer`, headers: { cookie: ctx.cookie }, payload });
    // Without saying it's the owner's own answer, the options still rule.
    expect((await answer({ answer: "C2 only, and write C5 up as a note" })).statusCode).toBe(422);
    expect((await answer({ answer: "C2 only, and write C5 up as a note", custom: true })).statusCode).toBe(200);
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, d!.id));
    expect(after).toMatchObject({ status: "answered", answer: "C2 only, and write C5 up as a note" });
    expect(await ctx.db.select({ note: wakes.note }).from(wakes).where(eq(wakes.reason, "decision answered"))).toEqual([{ note: expect.stringContaining("C2 only, and write C5 up as a note") }]);

    // A decision that acts on its answer (here a permission) never takes free text.
    const [perm] = await ctx.db
      .insert(decisions)
      .values({ companyId: ctx.appCo.company.id, kind: "permission", question: "CEO wants to run: rm -rf /", options: ["Allow", "Deny"], recommendedOption: "Deny", tier: "owner", context: { type: "permission", runnerId: crypto.randomUUID(), runId: crypto.randomUUID(), requestId: "r9" } })
      .returning();
    const res = await ctx.app.inject({ method: "POST", url: `/api/decisions/${perm!.id}/answer`, headers: { cookie: ctx.cookie }, payload: { answer: "Allow it this once", custom: true } });
    expect(res.statusCode).toBe(422);
    await c.close();
  });

  it("request_engagement wakes the other company's CEO, whose acceptance the owner approves", async () => {
    await ctx.db.insert(projects).values({ companyId: ctx.appCo.company.id, name: "Customer app" });
    const c = await client(ctx.appCo.company.id, ctx.appCo.ceo.id);
    const self = await c.callTool({ name: "request_engagement", arguments: { providerCompany: "App Co", title: "x", scope: "x", acceptanceCriteria: ["x"] } });
    expect(self.isError).toBe(true);
    const ok = await c.callTool({
      name: "request_engagement",
      arguments: { providerCompany: "Homelab Co", title: "Deploy v1.4", scope: "Deploy release v1.4 behind the proxy", acceptanceCriteria: ["Health check 200 for 10 min"], budgetCapUsd: 25 },
    });
    expect(textOf(ok)).toMatch(/sent to Homelab Co/);
    const [eng] = await ctx.db.select().from(engagements);
    expect(eng).toMatchObject({ status: "requested", budgetCapMicros: 25_000_000, providerCompanyId: ctx.homelab.company.id });
    expect(await ctx.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: ctx.homelab.ceo.id, reason: "engagement" })]);

    // Homelab's CEO accepts; the owner approves before work starts.
    const h = await client(ctx.homelab.company.id, ctx.homelab.ceo.id);
    const wrongSide = await c.callTool({ name: "engagement", arguments: { action: "accept", engagementId: eng!.id } });
    expect(textOf(wrongSide)).toBe("Only the provider can accept.");
    expect(textOf(await h.callTool({ name: "engagement", arguments: { action: "accept", engagementId: eng!.id } }))).toMatch(/owner approves/);
    const [approval] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "engagement"));
    expect(approval).toMatchObject({ companyId: ctx.homelab.company.id, question: 'Homelab Co has agreed to do "Deploy v1.4" for App Co, capped at $25.00. Approve the work?', recommendedOption: "Approve" });
    await ctx.app.inject({ method: "POST", url: `/api/decisions/${approval!.id}/answer`, headers: { cookie: ctx.cookie }, payload: { answer: "Approve" } });
    expect((await ctx.db.select().from(engagements))[0]!.status).toBe("accepted");
    await c.close();
    await h.close();
  });
});
