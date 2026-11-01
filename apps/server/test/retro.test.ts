// Workflow retros (docs/19-workflow-retros.md parts 2 and 3): when one starts, what the retro agent can call,
// and what each approved change writes.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agentChanges, agentSkills, agents, companies, decisions, retros, skillProposals, skills, ticketReviews, tickets, wakes, wikiPages, workflowChanges } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { LESSON_ADD, LESSON_DROP } from "../src/services/project-brief.js";
import { SKILL_ADD, SKILL_REJECT } from "../src/services/decisions.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await Promise.all((ctx?.clients ?? []).map((c) => c.close()));
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const D = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function setup(opts: { pm?: boolean; reviewer?: boolean } = {}) {
  const { db: pg, close } = await openPglite();
  const built = await buildApp({ db: pg, master: { version: 1, key: randomBytes(32) }, secureCookies: false, workspaceRoot: "/ws", tickOnWake: false });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "Retro Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const db = pg;
  await db.update(companies).set({ createdAt: ago(30 * D) }).where(eq(companies.id, company.id));
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Notes" })).json() as { id: string };
  const hire = async (name: string, template: string) => (await req("POST", `/api/companies/${company.id}/agents`, { name, template })).json() as { id: string };
  const pm = opts.pm === false ? null : await hire("Pat", "product-manager");
  const eng = await hire("Eve", "engineer");
  const eng2 = await hire("Ed", "engineer");
  const reviewer = opts.reviewer === false ? null : await hire("Sam", "security-reviewer");
  if (reviewer) await db.update(agents).set({ reviewKind: "security" }).where(eq(agents.id, reviewer.id));
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(pg, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  /** n finished tickets, finished `age` ms ago. */
  const done = async (n: number, age: number, patch: Partial<typeof tickets.$inferInsert> = {}) => {
    const rows = [];
    for (let i = 0; i < n; i++) rows.push((await db.insert(tickets).values({ companyId: company.id, projectId: project.id, title: `Done ${i}`, systemState: "done", stateChangedAt: ago(age), assigneeAgentId: eng.id, ...patch }).returning())[0]!);
    return rows;
  };
  const priorRetro = (age: number) => db.insert(retros).values({ companyId: company.id, agentId: pm?.id ?? ceo.id, startedAt: ago(age), since: ago(age + 7 * D), until: ago(age), doneCount: 5 }).returning().then((r) => r[0]!);
  const wakeFor = async (reason = "retro") => db.select().from(wakes).where(and(eq(wakes.companyId, company.id), eq(wakes.reason, reason)));
  return { ...built, db, close, clients, req, company, ceo, project, pm, eng, eng2, reviewer, mcp, done, priorRetro, wakeFor };
}
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
/** A tool call whose refusal may come back as an error result or a thrown protocol error. */
const tool = (cl: Client, name: string, args: object = {}) => cl.callTool({ name, arguments: args as never }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const ref = async (c: NonNullable<typeof ctx>, id: string) => {
  const [t] = await c.db.select({ n: tickets.number }).from(tickets).where(eq(tickets.id, id));
  const [co] = await c.db.select({ p: companies.ticketPrefix }).from(companies).where(eq(companies.id, c.company.id));
  return `${co!.p}-${t!.n}`;
};

describe("when a retro starts", () => {
  it("waits for 5 done tickets the first time, then starts and wakes the Product Manager", async () => {
    const c = (ctx = await setup());
    await c.done(4, D);
    expect(await c.retro.start(c.company.id)).toMatchObject({ started: false });
    await c.done(1, D);
    const r = await c.retro.start(c.company.id);
    expect(r.started).toBe(true);
    const [row] = await c.db.select().from(retros);
    expect(row).toMatchObject({ companyId: c.company.id, agentId: c.pm!.id, doneCount: 5, findings: null });
    const w = await c.wakeFor();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ agentId: c.pm!.id, ticketId: null });
    expect(w[0]!.note).toContain("5 tickets were finished");
    // Nothing done since: no second one, even forced.
    expect(await c.retro.start(c.company.id)).toMatchObject({ started: false });
    expect((await c.req("POST", `/api/companies/${c.company.id}/retro`)).statusCode).toBe(409);
  });

  it("starts at 20 done tickets", async () => {
    const c = (ctx = await setup());
    await c.priorRetro(D);
    await c.done(19, D / 2);
    expect(await c.retro.start(c.company.id)).toMatchObject({ started: false, reason: "Not due yet." });
    await c.done(1, D / 2);
    expect((await c.retro.start(c.company.id)).started).toBe(true);
  });

  it("starts after 7 days when anything was done", async () => {
    const c = (ctx = await setup());
    await c.priorRetro(8 * D);
    await c.done(1, 2 * D);
    expect(await c.retro.sweep()).toBe(1);
    expect(await c.wakeFor()).toHaveLength(1);
  });

  it("never starts when nothing was done since the last one", async () => {
    const c = (ctx = await setup());
    await c.priorRetro(8 * D);
    expect(await c.retro.sweep()).toBe(0);
    // Tickets done before the last retro don't count towards the next, nor does a cancelled one.
    await c.done(30, 9 * D);
    await c.done(1, D, { outcome: "cancelled" });
    expect(await c.retro.sweep()).toBe(0);
  });

  it("forces one on demand when anything was done since the last", async () => {
    const c = (ctx = await setup());
    await c.priorRetro(D);
    await c.done(1, D / 2);
    const res = await c.req("POST", `/api/companies/${c.company.id}/retro`);
    expect(res.statusCode).toBe(201);
    expect(await c.wakeFor()).toHaveLength(1);
  });

  it("picks the Product Manager, else the CEO, else the agent Settings names", async () => {
    const c = (ctx = await setup({ pm: false }));
    await c.done(5, D);
    expect(await c.retro.status(c.company.id)).toMatchObject({ agentId: null, runner: { id: c.ceo.id, source: "ceo" }, doneSince: 5 });
    await c.retro.start(c.company.id);
    expect((await c.wakeFor())[0]!.agentId).toBe(c.ceo.id);

    // The owner picks an engineer in Settings.
    const put = await c.req("PUT", `/api/companies/${c.company.id}/retro-settings`, { agentId: c.eng.id });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ agentId: c.eng.id, runner: { id: c.eng.id, source: "chosen" } });
    await new Promise((r) => setTimeout(r, 20));
    await c.done(1, 0);
    await c.retro.start(c.company.id, { force: true });
    expect((await c.wakeFor()).map((w) => w.agentId)).toContain(c.eng.id);

    // A retired pick is ignored.
    await c.req("POST", `/api/agents/${c.eng.id}/retire`);
    expect((await c.retro.status(c.company.id)).runner).toMatchObject({ id: c.ceo.id });
    expect((await c.req("PUT", `/api/companies/${c.company.id}/retro-settings`, { agentId: c.eng.id })).statusCode).toBe(404);
    const [other] = await c.db.insert(companies).values({ name: "Other" }).returning();
    const [foreign] = await c.db.insert(agents).values({ companyId: other!.id, name: "X", role: "worker", agentKind: "claude" }).returning();
    expect((await c.req("PUT", `/api/companies/${c.company.id}/retro-settings`, { agentId: foreign!.id })).statusCode).toBe(404);
  });

  it("isn't held back by the limit on wakes with no ticket", async () => {
    const c = (ctx = await setup());
    for (let i = 0; i < 9; i++) await c.scheduler.wake({ agentId: c.pm!.id, reason: "retro", note: "go" });
    expect((await c.wakeFor()).filter((w) => w.status === "dropped")).toHaveLength(0);
  });
});

async function open(c: NonNullable<typeof ctx>) {
  await c.done(5, D);
  await c.retro.start(c.company.id);
  return c.mcp(c.pm!.id);
}

describe("the retro agent's tools", () => {
  it("are offered to the retro agent only, and refused to anyone else", async () => {
    const c = (ctx = await setup());
    const pm = await open(c);
    const mine = (await pm.listTools()).tools.map((t) => t.name);
    expect(mine).toEqual(expect.arrayContaining(["workflow_scorecard", "save_retro", "propose_workflow_change"]));
    const other = (await (await c.mcp(c.eng.id)).listTools()).tools.map((t) => t.name);
    expect(other).not.toContain("workflow_scorecard");
    expect(isError(await tool(await c.mcp(c.eng.id), "save_retro"))).toBe(true);
    // The owner moves the job to the engineer: the Product Manager loses the tools straight away.
    await c.req("PUT", `/api/companies/${c.company.id}/retro-settings`, { agentId: c.eng.id });
    expect(isError(await tool(pm, "workflow_scorecard"))).toBe(true);
    expect(isError(await tool(await c.mcp(c.eng.id), "workflow_scorecard"))).toBe(false);
  });

  it("gives a bounded scorecard with digests of the worst tickets", async () => {
    const c = (ctx = await setup());
    const rows = await c.done(5, D);
    const bad = rows[0]!;
    for (const body of ["Missing the null case", "Still missing the null case in the importer"])
      await c.db.insert(ticketReviews).values({ ticketId: bad.id, reviewer: "Ed", verdict: "changes_requested", comments: [{ path: "src/a.ts", line: 3, body }] });
    await c.retro.start(c.company.id);
    const pm = await c.mcp(c.pm!.id);
    const out = textOf(await tool(pm, "workflow_scorecard"));
    expect(out).toContain("## Roles");
    expect(out).toContain("engineer");
    expect(out).toContain(`${await ref(c, bad.id)} "Done 0" (engineer, Eve): 2 rework rounds.`);
    expect(out).toContain("Still missing the null case in the importer");
    expect(out).not.toContain("Done 1");

  });

  it("tells the retro agent where sizes don't match actuals", async () => {
    const c = (ctx = await setup());
    const H = 3_600_000;
    await c.done(5, D);
    for (const [size, hours] of [[2, 4], [3, 30], [5, 32]] as const)
      for (let i = 0; i < 3; i++) {
        const [t] = await c.db.insert(tickets).values({ companyId: c.company.id, projectId: c.project.id, title: "Sized", size, assigneeAgentId: c.eng.id, systemState: "in_progress", stateChangedAt: ago(5 * D + hours * H) }).returning();
        await c.db.update(tickets).set({ systemState: "done", stateChangedAt: ago(5 * D + i * H) }).where(eq(tickets.id, t!.id));
      }
    await c.retro.start(c.company.id);
    const out = textOf(await tool(await c.mcp(c.pm!.id), "workflow_scorecard"));
    expect(out).toContain("## Task sizes");
    expect(out).toContain("- engineer, size 3: 3 done; 29.0 h;");
    expect(out).toContain("engineer: size 3 tickets take 29.0 h, closer to size 5 (31.0 h) than to the size below (3.0 h)");
    expect(out.length).toBeLessThanOrEqual(12_200);
  });

  it("keeps the scorecard short however many tickets went wrong", async () => {
    const c = (ctx = await setup());
    for (const t of await c.done(30, D / 2, { title: "T".repeat(300) })) for (let i = 0; i < 3; i++) await c.db.insert(ticketReviews).values({ ticketId: t.id, reviewer: "Ed", verdict: "changes_requested", comments: [{ path: "p".repeat(100), line: 1, body: "b".repeat(2000) }] });
    await c.retro.start(c.company.id);
    const big = textOf(await tool(await c.mcp(c.pm!.id), "workflow_scorecard"));
    expect(big.length).toBeLessThanOrEqual(12_200);
    expect(big.match(/rework rounds/g)!.length).toBeLessThanOrEqual(10);
  });

  it("saves ranked findings once, only for this company's tickets", async () => {
    const c = (ctx = await setup());
    const rows = await c.done(5, D);
    await c.retro.start(c.company.id);
    const pm = await c.mcp(c.pm!.id);
    const a = await ref(c, rows[0]!.id);
    const call = (findings: unknown) => tool(pm, "save_retro", { findings });
    const f = (over: object = {}) => ({ failure: "rework_loop", handoff: { from: "engineer", to: "senior-dev" }, tickets: [a], count: 3, note: "Sent back twice for the same thing.", ...over });

    expect(isError(await call([f({ failure: "bad_luck" })]))).toBe(true);
    expect(isError(await call([f({ tickets: [] })]))).toBe(true);
    expect(isError(await call([f({ note: "x".repeat(241) })]))).toBe(true);
    const unknown = await call([f({ tickets: ["ZZZ-999"] })]);
    expect(isError(unknown)).toBe(true);
    expect(textOf(unknown)).toContain("ZZZ-999");
    // Another company's ticket is not found here.
    const [other] = await c.db.insert(companies).values({ name: "Other", ticketPrefix: "OTH" }).returning();
    const [op] = await c.db.insert((await import("../src/db/schema.js")).projects).values({ companyId: other!.id, name: "P" }).returning();
    const [foreign] = await c.db.insert(tickets).values({ companyId: other!.id, projectId: op!.id, title: "Theirs" }).returning();
    expect(isError(await call([f({ tickets: [foreign!.id] })]))).toBe(true);

    expect(isError(await call([f(), f({ failure: "slow_review", tickets: [rows[1]!.id], count: 1 })]))).toBe(false);
    const [saved] = await c.db.select().from(retros);
    expect(saved!.savedAt).not.toBeNull();
    expect(saved!.findings).toHaveLength(2);
    expect(saved!.findings![0]).toMatchObject({ failure: "rework_loop", tickets: [rows[0]!.id], count: 3 });
    expect(isError(await call([f()]))).toBe(true);

    const latest = (await c.req("GET", `/api/companies/${c.company.id}/retros/latest`)).json();
    expect(latest.retro.findings[0]).toMatchObject({ failure: "rework_loop", failureLabel: expect.any(String), tickets: [a] });
  });
});

describe("proposing a change", () => {
  const propose = (pm: Client, over: Record<string, unknown> = {}) =>
    tool(pm, "propose_workflow_change", { lever: "instructions", target: "Eve", change: { instructions: "Always test the null case." }, evidence: ["A", "B"], metric: "firstPassRate", scope: { role: "engineer" }, expected: "Fewer send-backs.", ...over });

  async function ready(opts: { pm?: boolean; reviewer?: boolean } = {}) {
    const c = (ctx = await setup(opts));
    const rows = await c.done(5, D);
    for (const r of rows.slice(0, 3)) await c.db.insert(ticketReviews).values({ ticketId: r.id, reviewer: "Ed", verdict: "changes_requested", comments: [] });
    for (const r of rows.slice(3)) await c.db.insert(ticketReviews).values({ ticketId: r.id, reviewer: "Ed", verdict: "approved", comments: [] });
    await c.retro.start(c.company.id);
    const evidence = [await ref(c, rows[0]!.id), await ref(c, rows[1]!.id)];
    const pm = await c.mcp(c.pm!.id);
    return { c, pm, rows, evidence, p: (over: Record<string, unknown> = {}) => propose(pm, { evidence, ...over }) };
  }

  it("takes at most 3 per retro, one live per kind and target, and only known measures", async () => {
    const { c, p } = await ready();
    expect(isError(await p({ evidence: ["A"] }))).toBe(true);
    expect(isError(await p({ metric: "vibes" }))).toBe(true);
    expect(isError(await p({ lever: "plan_first" }))).toBe(true);
    // The same ticket twice is one ticket.
    const [first] = (await c.db.select({ id: tickets.id }).from(tickets)).slice(0, 1);
    expect(isError(await p({ evidence: [first!.id, first!.id] }))).toBe(true);

    const ok = await p();
    expect(isError(ok)).toBe(false);
    expect(textOf(ok)).toMatch(/waiting for the owner/);
    const [change] = await c.db.select().from(workflowChanges);
    expect(change).toMatchObject({ lever: "instructions", targetAgentId: c.eng.id, approver: "owner", status: "proposed", metric: "firstPassRate", metricScope: { role: "engineer" } });
    expect(change!.baseline).toBeCloseTo(0.4);
    expect(change!.evidence).toHaveLength(2);
    expect(change!.before).toEqual({ instructions: expect.any(String) });
    // One live change per lever and target.
    const dup = await p({ change: { instructions: "Something else." } });
    expect(isError(dup)).toBe(true);
    expect(textOf(dup)).toMatch(/already a proposed or applied change/);
    // A different target is fine; the third and fourth are counted.
    expect(isError(await p({ target: "Ed", change: { instructions: "Review twice." } }))).toBe(false);
    expect(isError(await p({ lever: "model", change: { model: "claude-sonnet-4-5" } }))).toBe(false);
    const fourth = await p({ lever: "thinking", change: { thinking: "high" } });
    expect(isError(fourth)).toBe(true);
    expect(textOf(fourth)).toMatch(/at most 3/);
    // A handoff measure needs both roles; the company one needs nothing.
    expect(await c.db.select().from(workflowChanges)).toHaveLength(3);
  });

  it("raises one Apply/Skip decision at the tier its approver sets", async () => {
    const { c, p } = await ready();
    await p();
    await p({ lever: "playbook", target: "engineer", change: { name: "null-checks", description: "Check the null case first.", body: "1. List the inputs.\n2. Test null." }, scope: { role: "engineer" } });
    await p({ lever: "review_policy", target: "high", change: { ownerSignoff: false }, scope: { role: "engineer" } });
    const rows = await c.db.select().from(workflowChanges);
    const tier = Object.fromEntries(rows.map((r) => [r.lever, r.approver]));
    expect(tier).toEqual({ instructions: "owner", playbook: "ceo", review_policy: "owner" });
    const ds = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect(ds).toHaveLength(3);
    for (const d of ds) {
      const change = rows.find((r) => r.decisionId === d.id)!;
      expect(d).toMatchObject({ tier: change.approver, options: ["Apply", "Skip"], recommendedOption: "Apply", status: "open", raisedByAgentId: c.pm!.id, dedupeKey: `workflow:${change.id}`, context: { type: "workflow_change", changeId: change.id } });
      expect(d.question).toContain("A workflow retro suggests a change");
      expect(d.question).toContain("Measured by: first-time review pass rate for engineer, now 40%");
    }
    // A playbook goes to the CEO, who is woken.
    expect((await c.wakeFor("decision")).some((w) => w.agentId === c.ceo.id)).toBe(true);
  });

  /** What the agent's history holds besides being hired. */
  const changes = (c: NonNullable<typeof ctx>, agentId: string) => c.db.select().from(agentChanges).where(and(eq(agentChanges.agentId, agentId), ne(agentChanges.field, "hired")));
  const answer = (c: NonNullable<typeof ctx>, decisionId: string, a: string, note = "Because it should help the team.", reasonLink?: string) => c.req("POST", `/api/decisions/${decisionId}/answer`, { answer: a, note, ...(reasonLink ? { reasonLink } : {}) });
  const decisionOf = async (c: NonNullable<typeof ctx>, lever: string) => {
    const [ch] = await c.db.select().from(workflowChanges).where(eq(workflowChanges.lever, lever));
    return { ch: ch!, id: ch!.decisionId! };
  };

  it("instructions, model and thinking apply through the agent history, and can be put back", async () => {
    const { c, p } = await ready();
    await p();
    await p({ lever: "model", target: "Ed", change: { model: "claude-sonnet-4-5" } });
    const { id } = await decisionOf(c, "instructions");
    const before = (await c.db.select().from(agents).where(eq(agents.id, c.eng.id)))[0]!.instructions;
    expect((await answer(c, id, "Apply")).statusCode).toBe(200);
    const [after] = await c.db.select().from(agents).where(eq(agents.id, c.eng.id));
    expect(after!.instructions).toBe("Always test the null case.");
    const history = await changes(c, c.eng.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ field: "instructions", before, after: "Always test the null case.", byAgentId: c.pm!.id });
    const [change] = await c.db.select().from(workflowChanges).where(eq(workflowChanges.lever, "instructions"));
    expect(change!.status).toBe("applied");
    expect(change!.checkDueAt!.getTime() - change!.appliedAt!.getTime()).toBe(14 * D);
    expect(change!.before).toEqual({ instructions: before });
    // Answering again does nothing more.
    expect((await answer(c, id, "Apply")).statusCode).toBeGreaterThanOrEqual(400);
    expect(await changes(c, c.eng.id)).toHaveLength(1);

    const m = await decisionOf(c, "model");
    expect((await answer(c, m.id, "Apply")).statusCode).toBe(200);
    expect((await c.db.select().from(agents).where(eq(agents.id, c.eng2.id)))[0]!.model).toBe("claude-sonnet-4-5");
    expect((await changes(c, c.eng2.id))[0]).toMatchObject({ field: "model", after: "claude-sonnet-4-5" });
  });

  it("Skip changes nothing", async () => {
    const { c, p } = await ready();
    await p();
    const { id } = await decisionOf(c, "instructions");
    expect((await answer(c, id, "Skip")).statusCode).toBe(200);
    expect((await decisionOf(c, "instructions")).ch.status).toBe("skipped");
    expect((await c.db.select().from(agents).where(eq(agents.id, c.eng.id)))[0]!.instructions).not.toBe("Always test the null case.");
    expect(await changes(c, c.eng.id)).toHaveLength(0);
  });

  it("requires a reason on Apply and Skip, and shows who decided, why and the wiki section", async () => {
    const { c, p } = await ready();
    await p();
    const { id, ch } = await decisionOf(c, "instructions");
    const blank = await c.req("POST", `/api/decisions/${id}/answer`, { answer: "Skip", note: "   " });
    expect(blank.statusCode).toBe(422);
    expect(blank.json().message).toMatch(/reason can't be empty/);
    // A link that isn't a wiki slug is refused before anything closes.
    const badLink = await c.req("POST", `/api/decisions/${id}/answer`, { answer: "Skip", note: "Not now.", reasonLink: "https://example.com/why" });
    expect(badLink.statusCode).toBe(422);
    expect(badLink.json().message).toMatch(/wiki page address/);
    const link = "product/decisions/workflow-retro-changes-why-each-was-applied-or-skipped#Skipped: class-level-regression-tests (QA agents)";
    expect((await answer(c, id, "Skip", "Adds a skill; waits for BOS-172.", link)).statusCode).toBe(200);
    const [row] = await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, ch.id));
    expect(row).toMatchObject({ status: "skipped", reason: "Adds a skill; waits for BOS-172.", reasonLink: link, decidedBy: "owner" });
    const latest = (await c.req("GET", `/api/companies/${c.company.id}/retros/latest`)).json();
    expect(latest.changes[0]).toMatchObject({ id: ch.id, status: "skipped", reason: "Adds a skill; waits for BOS-172.", reasonLink: link, decidedBy: "owner" });
  });

  it("leaves an old change without a reason, and lets the CEO add one and a link afterwards", async () => {
    const { c, p } = await ready();
    await p();
    const { id, ch } = await decisionOf(c, "instructions");
    await answer(c, id, "Skip");
    // An old row from before reasons were stored.
    await c.db.update(workflowChanges).set({ reason: null, reasonLink: null, decidedBy: null }).where(eq(workflowChanges.id, ch.id));
    const before = (await c.req("GET", `/api/companies/${c.company.id}/retros/latest`)).json().changes.find((x: { id: string }) => x.id === ch.id);
    expect(before).toMatchObject({ reason: null, reasonLink: null, decidedBy: null });

    const ceo = await c.mcp(c.ceo.id);
    const list = await tool(ceo, "decisions", { action: "changes" });
    expect(textOf(list)).toContain(ch.id);
    expect(textOf(list)).toContain("No reason recorded");
    const link = "product/decisions/workflow-retro-changes-why-each-was-applied-or-skipped#Skipped: prove-in-environment (senior-infra agents)";
    expect(isError(await tool(ceo, "decisions", { action: "explain", changeId: ch.id, reason: "The CEO's hold on new skills until BOS-172.", reasonLink: link }))).toBe(false);
    const [row] = await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, ch.id));
    expect(row).toMatchObject({ reason: "The CEO's hold on new skills until BOS-172.", reasonLink: link, decidedBy: "ceo" });
  });

  it("refuses to Apply when the agent is retired or the value moved on, and says why", async () => {
    const { c, p } = await ready();
    await p();
    await p({ lever: "model", target: "Ed", change: { model: "claude-sonnet-4-5" } });
    const a = await decisionOf(c, "instructions");
    await c.req("POST", `/api/agents/${c.eng.id}/retire`);
    const res = await answer(c, a.id, "Apply");
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/retired/);
    expect((await c.db.select().from(decisions).where(eq(decisions.id, a.id)))[0]!.status).toBe("open");
    // Skip is still open to them.
    expect((await answer(c, a.id, "Skip")).statusCode).toBe(200);

    const b = await decisionOf(c, "model");
    await c.db.update(agents).set({ model: "something-else" }).where(eq(agents.id, c.eng2.id));
    const moved = await answer(c, b.id, "Apply");
    expect(moved.statusCode).toBe(422);
    expect(moved.json().message).toMatch(/has changed since/);
    expect((await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, b.ch.id)))[0]!.status).toBe("proposed");
  });

  it("review policy changes one tier and keeps the old rule", async () => {
    const { c, p } = await ready();
    const was = (await c.db.select({ policy: companies.reviewPolicy }).from(companies).where(eq(companies.id, c.company.id)))[0]!.policy;
    expect(isError(await p({ lever: "review_policy", target: "huge", change: {} }))).toBe(true);
    expect(isError(await p({ lever: "review_policy", target: "high", change: { reviewer: randomUUID() } }))).toBe(true);
    expect(isError(await p({ lever: "review_policy", target: "high", change: { ownerSignoff: true } }))).toBe(true);
    await p({ lever: "review_policy", target: "high", change: { ownerSignoff: false } });
    const { id, ch } = await decisionOf(c, "review_policy");
    expect(ch.before).toEqual({ tier: "high", rule: was.high });
    expect((await answer(c, id, "Apply")).statusCode).toBe(200);
    const policy = (await c.db.select({ policy: companies.reviewPolicy }).from(companies).where(eq(companies.id, c.company.id)))[0]!.policy;
    expect(policy.high).toEqual({ ...was.high, ownerSignoff: false });
    expect(policy.low).toEqual(was.low);
  });

  it("watchdog limits are replayed over 14 days first, and applied through the watchdog", async () => {
    const { c, p } = await ready();
    expect(isError(await p({ lever: "watchdog", target: "watchdog", change: { enabled: true } }))).toBe(true);
    // Record only silences the watchdog, so it is the owner's alone, like enabled (BOS-166).
    expect(isError(await p({ lever: "watchdog", target: "watchdog", change: { recordOnly: true } }))).toBe(true);
    expect(isError(await p({ lever: "watchdog", target: "watchdog", change: { reviewHours: 0 } }))).toBe(true);
    await p({ lever: "watchdog", target: "watchdog", change: { reviewHours: 6, inProgressHours: 4 }, metric: "watchdogFlags" });
    const { id, ch } = await decisionOf(c, "watchdog");
    expect(ch).toMatchObject({ approver: "owner", before: { reviewHours: 2, inProgressHours: 2 }, after: { reviewHours: 6, inProgressHours: 4 } });
    const [d] = await c.db.select().from(decisions).where(eq(decisions.id, id));
    expect(d!.question).toMatch(/Replayed over the last 14 days: the current limits would have raised \d+ flags? \(\d+ cleared within 30 minutes on their own\); the new limits would have raised \d+/);
    expect((await answer(c, id, "Apply")).statusCode).toBe(200);
    const [co] = await c.db.select({ w: companies.watchdog }).from(companies).where(eq(companies.id, c.company.id));
    expect(co!.w).toMatchObject({ reviewHours: 6, inProgressHours: 4, enabled: false });
  });

  it("the CEO never approves its own proposal: with no Product Manager, playbooks go to the owner", async () => {
    const c = (ctx = await setup({ pm: false }));
    const rows = await c.done(5, D);
    await c.retro.start(c.company.id);
    const ceo = await c.mcp(c.ceo.id);
    const evidence = [await ref(c, rows[0]!.id), await ref(c, rows[1]!.id)];
    expect(isError(await propose(ceo, { evidence, lever: "playbook", target: "engineer", change: { name: "null-checks", description: "d", body: "b" } }))).toBe(false);
    const [ch] = await c.db.select().from(workflowChanges);
    expect(ch!.approver).toBe("owner");
    expect((await c.db.select().from(decisions).where(eq(decisions.id, ch!.decisionId!)))[0]!.tier).toBe("owner");
  });

  it("a playbook is only nominated: it reaches the library and agents after the security review and the owner's Add", async () => {
    const { c, p } = await ready();
    const clash = await c.db.insert(skills).values({ companyId: c.company.id, name: "taken", description: "d", source: "written", files: [], sizeBytes: 0 }).returning();
    expect(clash).toHaveLength(1);
    expect(isError(await p({ lever: "playbook", target: "wizard", change: { name: "x", description: "d", body: "b" } }))).toBe(true);
    expect(isError(await p({ lever: "playbook", target: "engineer", change: { name: "taken", description: "d", body: "b" } }))).toBe(true);
    await p({ lever: "playbook", target: "engineer", change: { name: "null-checks", description: "Check the null case first.", body: "1. List the inputs.\n2. Test null." } });
    const { id, ch } = await decisionOf(c, "playbook");
    expect(ch).toMatchObject({ approver: "ceo", targetRole: "engineer", targetAgentId: null, before: { skillId: null } });
    expect((await c.db.select().from(decisions).where(eq(decisions.id, id)))[0]!.tier).toBe("ceo");
    expect((await c.db.select().from(decisions).where(eq(decisions.id, id)))[0]!.question).toContain("the agents get it only after the owner adds it");
    // Apply is the nomination: nothing is in the library and no agent has it.
    expect((await answer(c, id, "Apply")).statusCode).toBe(200);
    expect(await c.db.select().from(skills).where(eq(skills.name, "null-checks"))).toHaveLength(0);
    const [proposal] = await c.db.select().from(skillProposals).where(eq(skillProposals.name, "null-checks"));
    expect(proposal).toMatchObject({ source: "retro", status: "in_review", proposedByAgentId: c.pm!.id, proposedAgentIds: [c.eng.id, c.eng2.id].sort() });
    expect((await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, ch.id)))[0]!.after).toMatchObject({ proposalId: proposal!.id });
    // The Security Reviewer recommends it; then the owner's skill card adds it.
    await c.skillProposals.recordVerdict(c.company.id, c.reviewer!.id, proposal!.id, { bundleHash: proposal!.bundleHash, verdict: "recommend", summary: "No scripts; a plain checklist." });
    const [card] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `skill:${proposal!.id}`));
    expect(card).toMatchObject({ kind: "skill", tier: "owner", status: "open" });
    expect((await answer(c, card!.id, SKILL_ADD)).statusCode).toBe(200);
    const [skill] = await c.db.select().from(skills).where(eq(skills.name, "null-checks"));
    expect(skill).toMatchObject({ source: "retro", description: "Check the null case first." });
    const held = (await c.db.select().from(agentSkills).where(eq(agentSkills.skillId, skill!.id))).map((r) => r.agentId).sort();
    expect(held).toEqual([c.eng.id, c.eng2.id].sort());
    expect((await c.db.select().from(skillProposals).where(eq(skillProposals.id, proposal!.id)))[0]).toMatchObject({ status: "installed", installedSkillId: skill!.id });
    expect((await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, ch.id)))[0]).toMatchObject({ status: "applied", after: { proposalId: proposal!.id, assignedAgentIds: [c.eng.id, c.eng2.id].sort() } });
  });

  it("links the change to its proposal before the proposal is written, so a crash cannot orphan it", async () => {
    const { c, p } = await ready();
    await p({ lever: "playbook", target: "engineer", change: { name: "null-checks", description: "d", body: "b" }, scope: { role: "engineer" } });
    const { id, ch } = await decisionOf(c, "playbook");
    const original = c.skillProposals.propose.bind(c.skillProposals);
    let linkedAtPropose: string | undefined;
    c.skillProposals.propose = (async (input: Parameters<typeof original>[0]) => {
      const [seen] = await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, ch.id));
      linkedAtPropose = (seen!.after as { proposalId?: string }).proposalId;
      return original(input);
    }) as typeof c.skillProposals.propose;
    expect((await answer(c, id, "Apply")).statusCode).toBe(200);
    const [proposal] = await c.db.select().from(skillProposals).where(eq(skillProposals.name, "null-checks"));
    expect(linkedAtPropose).toBe(proposal!.id);
  });

  it("a playbook is skipped, and reaches nobody, when there is no Security Reviewer", async () => {
    const { c, p } = await ready({ reviewer: false });
    await p({ lever: "playbook", target: "engineer", change: { name: "null-checks", description: "d", body: "b" } });
    const { id, ch } = await decisionOf(c, "playbook");
    expect((await answer(c, id, "Apply")).statusCode).toBe(200);
    expect(await c.db.select().from(skills).where(eq(skills.name, "null-checks"))).toHaveLength(0);
    expect(await c.db.select().from(skillProposals)).toHaveLength(0);
    expect((await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, ch.id)))[0]!.status).toBe("skipped");
  });

  it("a playbook the owner rejects reaches nobody", async () => {
    const { c, p } = await ready();
    await p({ lever: "playbook", target: "engineer", change: { name: "null-checks", description: "d", body: "b" } });
    const { id, ch } = await decisionOf(c, "playbook");
    await answer(c, id, "Apply");
    const [proposal] = await c.db.select().from(skillProposals).where(eq(skillProposals.name, "null-checks"));
    await c.skillProposals.recordVerdict(c.company.id, c.reviewer!.id, proposal!.id, { bundleHash: proposal!.bundleHash, verdict: "recommend", summary: "No scripts." });
    const [card] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `skill:${proposal!.id}`));
    expect((await answer(c, card!.id, SKILL_REJECT)).statusCode).toBe(200);
    expect(await c.db.select().from(skills).where(eq(skills.name, "null-checks"))).toHaveLength(0);
    expect(await c.db.select().from(agentSkills)).toHaveLength(0);
    expect((await c.db.select().from(skillProposals).where(eq(skillProposals.id, proposal!.id)))[0]!.status).toBe("rejected");
    expect((await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, ch.id)))[0]!.status).toBe("applied");
  });

  it("a lesson raises the existing lesson decision for the CEO, and counts as applied once it is added", async () => {
    const { c, p } = await ready();
    expect(isError(await p({ lever: "lesson", target: "No Such Project", change: { lesson: "Test null." } }))).toBe(true);
    await p({ lever: "lesson", target: "notes", change: { lesson: "Always cover the null case in importers." }, metric: "meanRework", scope: { role: "engineer" } });
    const { ch, id } = await decisionOf(c, "lesson");
    expect(ch).toMatchObject({ approver: "ceo", status: "proposed" });
    const [d] = await c.db.select().from(decisions).where(eq(decisions.id, id));
    expect(d).toMatchObject({ kind: "question", tier: "ceo", options: ["Add", "Edit", "Drop"], context: { type: "lesson", projectId: c.project.id, lesson: "Always cover the null case in importers." } });
    // No second decision type is made.
    expect(await c.db.select().from(decisions).where(eq(decisions.kind, "approval"))).toHaveLength(0);
    expect((await answer(c, id, LESSON_ADD)).statusCode).toBe(200);
    expect((await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, ch.id)))[0]).toMatchObject({ status: "applied" });
    expect((await c.db.select().from(wikiPages))[0]!.body).toContain("Always cover the null case in importers.");
  });

  it("a dropped lesson is a skipped change", async () => {
    const { c, p } = await ready();
    await p({ lever: "lesson", target: "Notes", change: { lesson: "Always cover the null case in importers." }, metric: "meanRework", scope: { role: "engineer" } });
    const { id, ch } = await decisionOf(c, "lesson");
    expect((await answer(c, id, LESSON_DROP)).statusCode).toBe(200);
    expect((await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, ch.id)))[0]!.status).toBe("skipped");
  });

  it("measures a handoff pair and the whole company", async () => {
    const { c, p } = await ready();
    expect(isError(await p({ metric: "bounceRate", scope: undefined }))).toBe(true);
    expect(isError(await p({ metric: "bounceRate", scope: { from: "engineer" } }))).toBe(true);
    expect(isError(await p({ target: "Ed", change: { instructions: "Be brief." }, metric: "firstPassRate", scope: undefined }))).toBe(false);
    expect(isError(await p({ lever: "model", change: { model: "m" }, metric: "tailLagMs", scope: undefined }))).toBe(false);
    const rows = await c.db.select().from(workflowChanges);
    expect(rows.map((r) => r.metricScope)).toEqual([{ agentId: c.eng2.id }, {}]);
    expect(rows.every((r) => r.baseline === null || typeof r.baseline === "number")).toBe(true);
  });
});

describe("checking a change's result (part 4)", () => {
  const propose = (pm: Client, over: Record<string, unknown>) =>
    tool(pm, "propose_workflow_change", { lever: "instructions", target: "Eve", change: { instructions: "Always test the null case." }, metric: "firstPassRate", scope: { role: "engineer" }, expected: "Fewer send-backs.", ...over });
  const answer = (c: NonNullable<typeof ctx>, decisionId: string, a: string, note = "Because it should help the team.", reasonLink?: string) => c.req("POST", `/api/decisions/${decisionId}/answer`, { answer: a, note, ...(reasonLink ? { reasonLink } : {}) });
  const decisionRow = async (c: NonNullable<typeof ctx>, id: string) => (await c.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
  const changeRow = async (c: NonNullable<typeof ctx>, id: string) => (await c.db.select().from(workflowChanges).where(eq(workflowChanges.id, id)))[0]!;
  /** n tickets finished a day ago, each with one review. */
  const finish = async (c: NonNullable<typeof ctx>, n: number, verdict: "approved" | "changes_requested" | null, assignee?: string) => {
    for (const t of await c.done(n, D, { assigneeAgentId: assignee ?? c.eng.id })) if (verdict) await c.db.insert(ticketReviews).values({ ticketId: t.id, reviewer: "Ed", verdict, comments: [] });
  };

  /** A retro with 5 finished tickets (40% first-time pass) and an agent that can propose. `apply` moves the tickets out of every later window. */
  async function ready(opts: { pm?: boolean; reviewer?: boolean } = {}) {
    const c = (ctx = await setup(opts));
    const rows = await c.done(5, D);
    for (const [i, r] of rows.entries()) await c.db.insert(ticketReviews).values({ ticketId: r.id, reviewer: "Ed", verdict: i < 3 ? "changes_requested" : "approved", comments: [] });
    await c.retro.start(c.company.id);
    const evidence = [await ref(c, rows[0]!.id), await ref(c, rows[1]!.id)];
    const pm = await c.mcp(opts.pm === false ? c.ceo.id : c.pm!.id);
    /** Proposes and applies a change, then makes it `ageDays` old. */
    const apply = async (over: Record<string, unknown> = {}, ageDays = 20) => {
      expect(isError(await propose(pm, { evidence, ...over }))).toBe(false);
      const [ch] = await c.db.select().from(workflowChanges).where(eq(workflowChanges.lever, (over.lever as string) ?? "instructions"));
      const a = (over.lever as string) === "lesson" ? LESSON_ADD : "Apply";
      expect((await answer(c, ch!.decisionId!, a)).statusCode).toBe(200);
      if ((over.lever as string) === "playbook") {
        const [proposal] = await c.db.select().from(skillProposals).where(eq(skillProposals.name, (over.change as { name: string }).name));
        await c.skillProposals.recordVerdict(c.company.id, c.reviewer!.id, proposal!.id, { bundleHash: proposal!.bundleHash, verdict: "recommend", summary: "No scripts." });
        const [card] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `skill:${proposal!.id}`));
        expect((await answer(c, card!.id, SKILL_ADD)).statusCode).toBe(200);
      }
      await c.db.update(tickets).set({ stateChangedAt: ago(25 * D) }).where(eq(tickets.companyId, c.company.id));
      await c.db.update(workflowChanges).set({ appliedAt: ago(ageDays * D), checkDueAt: ago((ageDays - 14) * D) }).where(eq(workflowChanges.id, ch!.id));
      return ch!.id;
    };
    /** The Keep / Revert decision once the sweep has raised it. */
    const checked = async (changeId: string) => {
      await finish(c, 10, "approved");
      expect(await c.retro.checkSweep()).toBe(1);
      return decisionRow(c, (await changeRow(c, changeId)).checkDecisionId!);
    };
    return { c, rows, pm, apply, checked };
  }

  it("waits until the change is due and 10 relevant tickets are done since, or the 30-day cap", async () => {
    const { c, apply } = await ready();
    const id = await apply({}, 10);
    // Not due for another 4 days, however much is done.
    await finish(c, 12, "approved");
    expect(await c.retro.checkSweep()).toBe(0);
    // Due, but only 9 engineer tickets: the Product Manager's don't count.
    await c.db.update(workflowChanges).set({ checkDueAt: ago(D) }).where(eq(workflowChanges.id, id));
    await c.db.update(tickets).set({ stateChangedAt: ago(30 * D) }).where(eq(tickets.assigneeAgentId, c.eng.id));
    await finish(c, 9, "approved");
    await finish(c, 5, "approved", c.pm!.id);
    expect(await c.retro.checkSweep()).toBe(0);
    expect(await c.db.select().from(decisions).where(eq(decisions.kind, "approval"))).toHaveLength(1);
    await finish(c, 1, "approved");
    expect(await c.retro.checkSweep()).toBe(1);
    const ch = await changeRow(c, id);
    expect(ch.result).toMatchObject({ value: 1, sample: 10, capped: false });
    const d = await decisionRow(c, ch.checkDecisionId!);
    expect(d).toMatchObject({ kind: "approval", tier: "owner", options: ["Keep", "Revert"], recommendedOption: "Keep", status: "open", dedupeKey: `workflow-check:${id}`, context: { type: "workflow_check", changeId: id } });
    // Once only.
    expect(await c.retro.checkSweep()).toBe(0);
    expect(await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `workflow-check:${id}`))).toHaveLength(1);
  });

  it("raises it at 30 days with the few tickets there are, and says how few", async () => {
    const { c, apply } = await ready();
    const id = await apply({}, 31);
    await c.db.update(tickets).set({ stateChangedAt: ago(35 * D) }).where(eq(tickets.companyId, c.company.id));
    await finish(c, 3, "approved");
    expect(await c.retro.checkSweep()).toBe(1);
    const ch = await changeRow(c, id);
    expect(ch.result).toMatchObject({ sample: 3, capped: true });
    const q = (await decisionRow(c, ch.checkDecisionId!)).question;
    expect(q).toContain("rests on 3 finished tickets");
    expect(q).toContain("Fewer than 10 happened");
  });

  it("says in plain words how the number moved, using each measure's direction", async () => {
    const cases: Array<{ metric: string; baseline: number | null; verdict: "approved" | "changes_requested" | null; say: RegExp; pick: string }> = [
      { metric: "firstPassRate", baseline: 0.4, verdict: "approved", say: /Before it: 40%\. Now: 100%\.[\s\S]*moved the right way \(higher is better here\)/, pick: "Keep" },
      { metric: "firstPassRate", baseline: 0.9, verdict: "changes_requested", say: /Now: 0%\.[\s\S]*got worse \(higher is better here\)/, pick: "Revert" },
      { metric: "meanRework", baseline: 0.5, verdict: "changes_requested", say: /Before it: 0\.5\. Now: 1\.0\.[\s\S]*got worse \(lower is better here\)/, pick: "Revert" },
      { metric: "meanRework", baseline: 2, verdict: "approved", say: /moved the right way \(lower is better here\)/, pick: "Keep" },
      { metric: "meanRework", baseline: 0, verdict: "approved", say: /held steady/, pick: "Keep" },
      { metric: "firstPassRate", baseline: 0.4, verdict: null, say: /Now: n\/a\.[\s\S]*can't be measured/, pick: "Keep" },
      { metric: "firstPassRate", baseline: null, verdict: "approved", say: /Before it: n\/a\.[\s\S]*can't be measured/, pick: "Keep" },
    ];
    for (const k of cases) {
      const c = (ctx = await setup());
      const [ch] = await c.db
        .insert(workflowChanges)
        .values({ companyId: c.company.id, retroId: (await c.priorRetro(10 * D)).id, lever: "model", targetAgentId: c.eng.id, summary: "Set Eve's model.", before: { model: null }, after: { model: "m" }, metric: k.metric, metricScope: { role: "engineer" }, baseline: k.baseline, approver: "owner", status: "applied", appliedAt: ago(20 * D), checkDueAt: ago(6 * D) })
        .returning();
      await finish(c, 10, k.verdict);
      expect(await c.retro.checkSweep()).toBe(1);
      const d = await decisionRow(c, (await changeRow(c, ch!.id)).checkDecisionId!);
      expect(d.question).toMatch(k.say);
      expect(d.recommendedOption).toBe(k.pick);
      await Promise.all(c.clients.map((x) => x.close()));
      await c.app.close();
      await c.close();
      ctx = undefined;
    }
  });

  it("Keep leaves the change in place", async () => {
    const { c, apply, checked } = await ready();
    const id = await apply();
    const d = await checked(id);
    expect((await answer(c, d.id, "Keep")).statusCode).toBe(200);
    expect((await changeRow(c, id)).status).toBe("kept");
    expect((await c.db.select().from(agents).where(eq(agents.id, c.eng.id)))[0]!.instructions).toBe("Always test the null case.");
  });

  it("Revert puts instructions back through the agent history, and refuses when they have moved on", async () => {
    const { c, apply, checked } = await ready();
    const was = (await c.db.select().from(agents).where(eq(agents.id, c.eng.id)))[0]!.instructions;
    const id = await apply();
    const d = await checked(id);
    // Someone edited them since: Revert must not overwrite that, and the decision stays open.
    await c.db.update(agents).set({ instructions: "Newer words." }).where(eq(agents.id, c.eng.id));
    const refused = await answer(c, d.id, "Revert");
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toMatch(/has changed since this was applied/);
    expect((await decisionRow(c, d.id)).status).toBe("open");
    expect((await changeRow(c, id)).status).toBe("applied");
    expect((await c.db.select().from(agents).where(eq(agents.id, c.eng.id)))[0]!.instructions).toBe("Newer words.");
    // Back to what Apply wrote: now it goes.
    await c.db.update(agents).set({ instructions: "Always test the null case." }).where(eq(agents.id, c.eng.id));
    expect((await answer(c, d.id, "Revert")).statusCode).toBe(200);
    expect((await c.db.select().from(agents).where(eq(agents.id, c.eng.id)))[0]!.instructions).toBe(was);
    expect((await changeRow(c, id)).status).toBe("reverted");
    const history = await c.db.select().from(agentChanges).where(and(eq(agentChanges.agentId, c.eng.id), ne(agentChanges.field, "hired")));
    expect(history.map((h) => [h.before, h.after])).toEqual(expect.arrayContaining([[was, "Always test the null case."], ["Always test the null case.", was]]));
  });

  it("Revert puts the review policy tier back, and refuses when the tier has changed", async () => {
    const { c, apply, checked } = await ready();
    const was = (await c.db.select({ p: companies.reviewPolicy }).from(companies).where(eq(companies.id, c.company.id)))[0]!.p;
    const id = await apply({ lever: "review_policy", target: "high", change: { ownerSignoff: false } });
    const d = await checked(id);
    const policy = () => c.db.select({ p: companies.reviewPolicy }).from(companies).where(eq(companies.id, c.company.id)).then((r) => r[0]!.p);
    const applied = await policy();
    await c.db.update(companies).set({ reviewPolicy: { ...applied, high: { ...applied.high, ownerSignoff: true } } }).where(eq(companies.id, c.company.id));
    expect((await answer(c, d.id, "Revert")).statusCode).toBe(422);
    await c.db.update(companies).set({ reviewPolicy: applied }).where(eq(companies.id, c.company.id));
    expect((await answer(c, d.id, "Revert")).statusCode).toBe(200);
    expect(await policy()).toEqual(was);
    expect((await changeRow(c, id)).status).toBe("reverted");
  });

  it("Revert puts the watchdog limits back", async () => {
    const { c, apply, checked } = await ready();
    const id = await apply({ lever: "watchdog", target: "watchdog", change: { reviewHours: 6, inProgressHours: 4 }, metric: "watchdogFlags" });
    const d = await checked(id);
    expect((await answer(c, d.id, "Revert")).statusCode).toBe(200);
    const [co] = await c.db.select({ w: companies.watchdog }).from(companies).where(eq(companies.id, c.company.id));
    expect(co!.w).toMatchObject({ reviewHours: 2, inProgressHours: 2 });
  });

  it("Revert takes a playbook away only from the agents Apply gave it to, and keeps the skill", async () => {
    const { c, apply, checked } = await ready();
    const id = await apply({ lever: "playbook", target: "engineer", change: { name: "null-checks", description: "Check the null case first.", body: "Test null." } });
    const [skill] = await c.db.select().from(skills).where(eq(skills.name, "null-checks"));
    // The owner gave it to the Product Manager by hand afterwards: that is not Revert's to undo.
    await c.db.insert(agentSkills).values({ agentId: c.pm!.id, skillId: skill!.id });
    const d = await checked(id);
    expect(d.tier).toBe("ceo");
    expect(d.question).toContain("stays in the library");
    expect((await c.wakeFor("decision")).some((w) => w.agentId === c.ceo.id)).toBe(true);
    expect((await answer(c, d.id, "Revert")).statusCode).toBe(200);
    expect((await c.db.select().from(agentSkills).where(eq(agentSkills.skillId, skill!.id))).map((r) => r.agentId)).toEqual([c.pm!.id]);
    expect(await c.db.select().from(skills).where(eq(skills.id, skill!.id))).toHaveLength(1);
    expect((await changeRow(c, id)).status).toBe("reverted");
  });

  it("Revert of a playbook update puts the earlier version back in place, and says so", async () => {
    const { c, apply, checked } = await ready();
    const [existing] = await c.db
      .insert(skills)
      .values({ companyId: c.company.id, name: "null-checks", description: "Old", source: "retro", files: [{ path: "SKILL.md", content: Buffer.from("---\nname: null-checks\ndescription: \"Old\"\n---\n\nOLD\n").toString("base64") }], sizeBytes: 10 })
      .returning();
    // One engineer already had the old version; the update also reaches the other one.
    await c.db.insert(agentSkills).values({ agentId: c.eng.id, skillId: existing!.id });
    const id = await apply({ lever: "playbook", target: "engineer", change: { name: "null-checks", description: "New", body: "NEW" } });
    expect(Buffer.from((await c.db.select().from(skills).where(eq(skills.id, existing!.id)))[0]!.files[0]!.content, "base64").toString("utf8")).toContain("NEW");
    expect((await c.db.select().from(agentSkills).where(eq(agentSkills.skillId, existing!.id))).map((r) => r.agentId).sort()).toEqual([c.eng.id, c.eng2.id].sort());
    const d = await checked(id);
    expect(d.question).toContain("earlier version");
    expect((await answer(c, d.id, "Revert")).statusCode).toBe(200);
    const [back] = await c.db.select().from(skills).where(eq(skills.id, existing!.id));
    expect(Buffer.from(back!.files[0]!.content, "base64").toString("utf8")).toContain("OLD");
    // The engineer who had it keeps it; the one who only gained it from the update loses it.
    expect((await c.db.select().from(agentSkills).where(eq(agentSkills.skillId, existing!.id))).map((r) => r.agentId)).toEqual([c.eng.id]);
    expect((await changeRow(c, id)).status).toBe("reverted");
  });

  it("Revert drops a lesson from the brief, and refuses when it is no longer there", async () => {
    const { c, apply, checked } = await ready();
    const id = await apply({ lever: "lesson", target: "Notes", change: { lesson: "Always cover the null case in importers." }, metric: "meanRework" });
    expect((await c.db.select().from(wikiPages))[0]!.body).toContain("Always cover the null case in importers.");
    const d = await checked(id);
    expect(d.tier).toBe("ceo");
    expect(d.question).toContain("drops the lesson from the brief");
    await c.db.update(wikiPages).set({ body: "Describes commit unknown on unknown.\n" });
    expect((await answer(c, d.id, "Revert")).statusCode).toBe(422);
    await c.db.update(wikiPages).set({ body: "Describes commit unknown on unknown.\n\n## Lessons\n\n- Always cover the null case in importers.\n- Keep this one.\n" });
    expect((await answer(c, d.id, "Revert")).statusCode).toBe(200);
    const body = (await c.db.select().from(wikiPages))[0]!.body;
    expect(body).not.toContain("null case");
    expect(body).toContain("Keep this one.");
  });

  it("a playbook update is refused when the owner edited the skill before Apply", async () => {
    const { c, rows, pm } = await ready();
    const evidence = [await ref(c, rows[0]!.id), await ref(c, rows[1]!.id)];
    const [existing] = await c.db
      .insert(skills)
      .values({ companyId: c.company.id, name: "null-checks", description: "Old", source: "retro", files: [{ path: "SKILL.md", content: Buffer.from("---\nname: null-checks\ndescription: \"Old\"\n---\n\nOLD\n").toString("base64") }], sizeBytes: 10 })
      .returning();
    expect(isError(await propose(pm, { evidence, lever: "playbook", target: "engineer", change: { name: "null-checks", description: "New", body: "NEW" } }))).toBe(false);
    const [ch] = await c.db.select().from(workflowChanges).where(eq(workflowChanges.lever, "playbook"));
    // The owner edits the playbook by hand while the change waits for Apply.
    expect((await c.req("PUT", `/api/companies/${c.company.id}/skills/${existing!.id}`, { name: "null-checks", description: "Owner's own version", body: "OWNER EDIT" })).statusCode).toBe(200);
    const refused = await answer(c, ch!.decisionId!, "Apply");
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toMatch(/edited since this was proposed/);
    expect((await changeRow(c, ch!.id)).status).toBe("proposed");
    expect(await c.db.select().from(skillProposals)).toHaveLength(0);
    const [still] = await c.db.select().from(skills).where(eq(skills.id, existing!.id));
    expect(Buffer.from(still!.files[0]!.content, "base64").toString("utf8")).toContain("OWNER EDIT");
  });

  it("an owner's edit after Apply stops the update installing, so the edit is kept and Revert has nothing stale to restore", async () => {
    const { c, rows, pm } = await ready();
    const evidence = [await ref(c, rows[0]!.id), await ref(c, rows[1]!.id)];
    const [existing] = await c.db
      .insert(skills)
      .values({ companyId: c.company.id, name: "null-checks", description: "Old", source: "retro", files: [{ path: "SKILL.md", content: Buffer.from("---\nname: null-checks\ndescription: \"Old\"\n---\n\nOLD\n").toString("base64") }], sizeBytes: 10 })
      .returning();
    expect(isError(await propose(pm, { evidence, lever: "playbook", target: "engineer", change: { name: "null-checks", description: "New", body: "NEW" } }))).toBe(false);
    const [ch] = await c.db.select().from(workflowChanges).where(eq(workflowChanges.lever, "playbook"));
    expect((await answer(c, ch!.decisionId!, "Apply")).statusCode).toBe(200);
    const [proposal] = await c.db.select().from(skillProposals).where(eq(skillProposals.name, "null-checks"));
    expect(proposal!.replacesBundleHash).toBeTruthy();
    // The owner edits the playbook while the nomination waits for the security review and the owner.
    expect((await c.req("PUT", `/api/companies/${c.company.id}/skills/${existing!.id}`, { name: "null-checks", description: "Owner's own version", body: "OWNER EDIT" })).statusCode).toBe(200);
    await c.skillProposals.recordVerdict(c.company.id, c.reviewer!.id, proposal!.id, { bundleHash: proposal!.bundleHash, verdict: "recommend", summary: "No scripts." });
    const [card] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `skill:${proposal!.id}`));
    expect((await answer(c, card!.id, SKILL_ADD)).statusCode).toBe(200);
    // Nothing was installed: the owner's edit is still the skill, and the nomination is stale.
    const [now] = await c.db.select().from(skills).where(eq(skills.id, existing!.id));
    expect(Buffer.from(now!.files[0]!.content, "base64").toString("utf8")).toContain("OWNER EDIT");
    expect((await c.db.select().from(skillProposals).where(eq(skillProposals.id, proposal!.id)))[0]!.status).toBe("stale");
    expect((await changeRow(c, ch!.id)).status).toBe("applied");
  });

  it("a playbook's check while the nomination is pending offers a Revert that cancels it, and the card can be closed", async () => {
    const { c, rows, pm } = await ready();
    const evidence = [await ref(c, rows[0]!.id), await ref(c, rows[1]!.id)];
    expect(isError(await propose(pm, { evidence, lever: "playbook", target: "engineer", change: { name: "null-checks", description: "d", body: "b" } }))).toBe(false);
    const [ch] = await c.db.select().from(workflowChanges).where(eq(workflowChanges.lever, "playbook"));
    expect((await answer(c, ch!.decisionId!, "Apply")).statusCode).toBe(200);
    await c.db.update(tickets).set({ stateChangedAt: ago(25 * D) }).where(eq(tickets.companyId, c.company.id));
    await c.db.update(workflowChanges).set({ appliedAt: ago(20 * D), checkDueAt: ago(6 * D) }).where(eq(workflowChanges.id, ch!.id));
    await finish(c, 10, "approved");
    // Nothing has reached an agent: the card says Revert cancels the nomination, and it can be answered.
    expect(await c.retro.checkSweep()).toBe(1);
    const d = await decisionRow(c, (await changeRow(c, ch!.id)).checkDecisionId!);
    expect(d.question).toContain("cancels the pending skill nomination");
    expect(await c.db.select().from(skills)).toHaveLength(0);
    expect((await answer(c, d.id, "Revert")).statusCode).toBe(200);
    expect((await decisionRow(c, d.id)).status).toBe("answered");
    expect((await changeRow(c, ch!.id)).status).toBe("reverted");
    const [proposal] = await c.db.select().from(skillProposals).where(eq(skillProposals.name, "null-checks"));
    expect(proposal!.status).toBe("rejected");
    expect(await c.db.select().from(skills)).toHaveLength(0);
    expect(await c.db.select().from(agentSkills)).toHaveLength(0);
  });

  it("closes a playbook change as skipped, with no card, when its nomination ends without installing", async () => {
    const { c, rows, pm } = await ready();
    const evidence = [await ref(c, rows[0]!.id), await ref(c, rows[1]!.id)];
    expect(isError(await propose(pm, { evidence, lever: "playbook", target: "engineer", change: { name: "null-checks", description: "d", body: "b" } }))).toBe(false);
    const [ch] = await c.db.select().from(workflowChanges).where(eq(workflowChanges.lever, "playbook"));
    expect((await answer(c, ch!.decisionId!, "Apply")).statusCode).toBe(200);
    const [proposal] = await c.db.select().from(skillProposals).where(eq(skillProposals.name, "null-checks"));
    await c.skillProposals.recordVerdict(c.company.id, c.reviewer!.id, proposal!.id, { bundleHash: proposal!.bundleHash, verdict: "recommend", summary: "No scripts." });
    const [card] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `skill:${proposal!.id}`));
    expect((await answer(c, card!.id, SKILL_REJECT)).statusCode).toBe(200);
    await c.db.update(tickets).set({ stateChangedAt: ago(25 * D) }).where(eq(tickets.companyId, c.company.id));
    await c.db.update(workflowChanges).set({ appliedAt: ago(20 * D), checkDueAt: ago(6 * D) }).where(eq(workflowChanges.id, ch!.id));
    await finish(c, 10, "approved");
    // The change never took effect, so there is no effect to check and no card to raise.
    expect(await c.retro.checkSweep()).toBe(0);
    expect((await changeRow(c, ch!.id)).status).toBe("skipped");
    expect(await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `workflow-check:${ch!.id}`))).toHaveLength(0);
    expect(await c.db.select().from(agentSkills)).toHaveLength(0);
  });

  it("goes to the owner when the CEO ran the retro", async () => {
    const { c, apply, checked } = await ready({ pm: false });
    const id = await apply({ lever: "playbook", target: "engineer", change: { name: "null-checks", description: "d", body: "b" } });
    expect((await checked(id)).tier).toBe("owner");
  });
});
