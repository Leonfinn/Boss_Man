// BOS-1571: the usability gate. A feature must deliver its value in real use, without the owner on hand, before it
// merges. The check worker passed five reviews and went idle after every runner update until the owner hand-edited
// a file; nothing in Boss Man asked about the owner's repeated work. Each test here fails on the code before this ticket.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PLAN_REAL_USE_MISSING, SENIOR_DEV_TEMPLATE, USABILITY_CRITERION, type RunnerCommand, type WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, features, reviewRequests, runs, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { usabilityGateBlock } from "../src/mcp-decisions.js";
import { ReviewError } from "../src/services/review.js";
import { USABILITY_GATE_GUIDANCE } from "../src/services/scheduler.js";
import { lintOwnerSteps } from "../src/services/steps.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const WALK = "Real use: day 1 it runs on its own; after a runner update or restart it carries on with no owner step, and a week on there is nothing to repeat.";

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/example/site.git" });
  // The runner answers diffs with whatever files the test sets, and merges anything.
  const state = { files: ["src/a.ts"], patch: "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+x" };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, (c: RunnerCommand) => {
    const diff: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Add it" }], files: state.files.map((path) => ({ path, added: 1, removed: 0 })), diff: state.patch, truncated: false };
    if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: diff }));
    if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { status: "merged", commit: "c".repeat(40) } }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "none" } }));
    return true;
  }, ["carried-check"]);
  const hire = async (name: string, set: Partial<typeof agents.$inferInsert> = {}) => {
    const a = (await req("POST", `/api/companies/${company.id}/agents`, { name })).json() as { id: string };
    if (Object.keys(set).length) await db.update(agents).set(set).where(eq(agents.id, a.id));
    return a;
  };
  const worker = await hire("Engineer");
  const reviewer = await hire("Reviewer", { template: SENIOR_DEV_TEMPLATE });
  const [feature] = await db.insert(features).values({ companyId: company.id, title: "Check workers" }).returning();
  const clients: Client[] = [];
  const mcp = async (agentId: string, runId = randomUUID()) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  /** A ticket written straight to the table, so no create path adds the criterion. */
  const raw = async (set: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: company.id, projectId: project.id, title: `T ${randomUUID().slice(0, 6)}`, systemState: "in_progress", assigneeAgentId: worker.id, branch: "bossman/x", ...set }).returning())[0]!;
  const slot = async (ticketId: string, kind = "code") => (await db.insert(reviewRequests).values({ ticketId, kind, reviewerAgentId: reviewer.id, round: 1, status: "pending" }).returning())[0]!;
  const read = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  return { ...built, db, close, req, company, ceo, project, worker, reviewer, feature: feature!, clients, mcp, raw, slot, read, state };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

describe("the usability criterion is added without anyone remembering it", () => {
  it("create_ticket adds it to a feature's ticket and says so; a plain or no-code ticket gets none", async () => {
    const c = (ctx = await setup());
    const dev = await c.mcp(c.worker.id);
    const made = await dev.callTool({ name: "create_ticket", arguments: { size: 3, project: "Site", title: "Worker image", featureId: c.feature.id, acceptanceCriteria: ["It builds"] } });
    expect(textOf(made)).toContain("Usability gate added");
    const [featured] = await c.db.select().from(tickets).where(eq(tickets.title, "Worker image"));
    expect(featured!.acceptanceCriteria).toEqual(["It builds", USABILITY_CRITERION]);

    await dev.callTool({ name: "create_ticket", arguments: { size: 1, project: "Site", title: "Fix a typo" } });
    await dev.callTool({ name: "create_ticket", arguments: { size: 1, project: "Site", title: "Research it", featureId: c.feature.id, noCode: true } });
    const [plain] = await c.db.select().from(tickets).where(eq(tickets.title, "Fix a typo"));
    const [research] = await c.db.select().from(tickets).where(eq(tickets.title, "Research it"));
    expect(plain!.acceptanceCriteria).toEqual([]);
    expect(research!.acceptanceCriteria).toEqual([]);
  });

  it("the owner's and the feature page's tickets get it too, and replacing the criteria keeps it", async () => {
    const c = (ctx = await setup());
    const r = await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "From the board", featureId: c.feature.id });
    const id = (r.json() as { id: string }).id;
    expect((await c.read(id)).acceptanceCriteria).toEqual([USABILITY_CRITERION]);
    const ceo = await c.mcp(c.ceo.id);
    const out = await ceo.callTool({ name: "update_ticket", arguments: { ticketId: id, acceptanceCriteria: ["Only this one"], reason: "Rewrote the criteria" } });
    expect(isError(out)).toBe(false);
    expect((await c.read(id)).acceptanceCriteria).toEqual(["Only this one", USABILITY_CRITERION]);
  });

  it("a ticket that joins a feature later gets it", async () => {
    const c = (ctx = await setup());
    const t = await c.raw({ systemState: "backlog", assigneeAgentId: null });
    const ceo = await c.mcp(c.ceo.id);
    await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, featureId: c.feature.id, reason: "It delivers the feature" } });
    expect((await c.read(t.id)).acceptanceCriteria).toEqual([USABILITY_CRITERION]);
  });

  it("backstop: a feature ticket without it can't reach review until its author reports it, and the move stores it", async () => {
    const c = (ctx = await setup());
    const t = await c.raw({ featureId: c.feature.id, acceptanceCriteria: ["It builds"] });
    const dev = await c.mcp(c.worker.id);
    const refused = await dev.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "1 pass" } });
    expect(textOf(refused)).toMatch(/Not reported: "Usability gate/);
    expect(textOf(refused)).toMatch(/criterion 2/);
    expect((await c.read(t.id)).systemState).toBe("in_progress");
    const moved = await dev.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "1 pass; 2 pass: nothing for the owner to repeat after updates" } });
    expect(textOf(moved)).toContain("is now review");
    expect((await c.read(t.id)).acceptanceCriteria).toEqual(["It builds", USABILITY_CRITERION]);
  });

  it("a plain ticket moves to review exactly as before", async () => {
    const c = (ctx = await setup());
    const t = await c.raw();
    const dev = await c.mcp(c.worker.id);
    expect(textOf(await dev.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Done." } }))).toContain("is now review");
  });
});

describe("a reviewer can't approve a gated ticket without a real-use walk-through", () => {
  const submit = (c: NonNullable<typeof ctx>, id: string, summary: string | undefined, extra: { kind?: string; agent?: boolean } = {}) =>
    c.review.submit(id, { verdict: "approved", summary, reviewer: "Reviewer", ...(extra.agent === false ? {} : { reviewerAgentId: c.reviewer.id }), ...(extra.kind ? { kind: extra.kind } : {}), background: true });

  it("refuses a code approval of a feature ticket with no Real use, and takes one with it", async () => {
    const c = (ctx = await setup());
    const t = await c.raw({ systemState: "review", featureId: c.feature.id });
    await c.slot(t.id);
    await expect(submit(c, t.id, "Code is clean, tests pass.")).rejects.toThrow(ReviewError);
    await expect(submit(c, t.id, "Code is clean.\nReal use: fine")).rejects.toThrow(/usability gate/);
    const [row] = await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id));
    expect(row!.status).toBe("pending");
    await submit(c, t.id, `Code is clean.\n${WALK}`);
    const [after] = await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id));
    expect(after!.status).toBe("approved");
    expect(after!.notes).toContain("Real use:");
  });

  it("covers a change to what the owner installs even outside a feature, and leaves an ordinary change alone", async () => {
    const c = (ctx = await setup());
    c.state.files = ["docker-compose.check-worker.yml"];
    const install = await c.raw({ systemState: "review" });
    await c.slot(install.id);
    await expect(submit(c, install.id, "Looks right.")).rejects.toThrow(/Real use:/);
    c.state.files = ["src/a.ts"];
    const plain = await c.raw({ systemState: "review" });
    await c.slot(plain.id);
    await expect(submit(c, plain.id, "Looks right.")).resolves.toBeTruthy();
  });

  it("security reviews and the owner's own approval are never held to it", async () => {
    const c = (ctx = await setup());
    const t = await c.raw({ systemState: "review", featureId: c.feature.id });
    await c.slot(t.id, "security");
    await expect(submit(c, t.id, "No findings.", { kind: "security" })).resolves.toBeTruthy();
    const owned = await c.raw({ systemState: "review", featureId: c.feature.id });
    await expect(submit(c, owned.id, undefined, { agent: false })).resolves.toBeTruthy();
  });

  it("asking for changes needs no walk-through", async () => {
    const c = (ctx = await setup());
    const t = await c.raw({ systemState: "review", featureId: c.feature.id });
    await c.slot(t.id);
    await expect(c.review.submit(t.id, { verdict: "changes_requested", summary: "Fix the test.", reviewer: "Reviewer", reviewerAgentId: c.reviewer.id, background: true })).resolves.toBeTruthy();
  });
});

describe("plans and review texts carry the gate", () => {
  it("submit_plan refuses a gated plan with no walk-through and takes one with it", async () => {
    const c = (ctx = await setup());
    const t = await c.raw({ featureId: c.feature.id, planFirst: true });
    const dev = await c.mcp(c.worker.id);
    const refused = await dev.callTool({ name: "submit_plan", arguments: { ticketId: t.id, plan: "Build the worker image and the compose file." } });
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toMatch(/Real use:/);
    const ok = await dev.callTool({ name: "submit_plan", arguments: { ticketId: t.id, plan: `Build the worker image.\n${WALK}` } });
    expect(textOf(ok)).toMatch(/Plan card/);
  });

  it("a plan-mode card for a gated ticket says when its plan has no walk-through", async () => {
    const c = (ctx = await setup());
    const card = async (ticketId: string, planText: string) => {
      const runId = randomUUID();
      await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId, startedAt: new Date() });
      const requestId = randomUUID();
      await c.decisions.onPermissionRequest({ id: randomUUID(), companyId: c.company.id }, { type: "run.permission_request", runId, requestId, title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once", "reject_once"], detail: planText } as never);
      return (await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`)))[0]!;
    };
    const gated = await c.raw({ featureId: c.feature.id, planFirst: true });
    expect((await card(gated.id, "Build it.")).question).toContain(PLAN_REAL_USE_MISSING);
    const walked = await c.raw({ featureId: c.feature.id, planFirst: true });
    expect((await card(walked.id, `Build it.\n${WALK}`)).question).not.toContain(PLAN_REAL_USE_MISSING);
    const plain = await c.raw({ planFirst: true });
    expect((await card(plain.id, "Build it.")).question).not.toContain(PLAN_REAL_USE_MISSING);
  });

  it("the review wake's guidance names the lifecycle and the fail rule, for every company", () => {
    for (const s of ["day 1", "after the next update", "after a restart", "a week on", "the owner away", "repeat routinely", "only while someone watches it", "Real use:"]) expect(USABILITY_GATE_GUIDANCE).toContain(s);
    expect(USABILITY_GATE_GUIDANCE).not.toContain("\n");
  });

  it("the review diff shows the gate and the check worker's own duty sentence", () => {
    const patch = ["+++ b/docs/26-check-workers.md", "@@ -40,0 +41,2 @@", "+Paste the commit into compose.yaml.", "+Do this soon: until then the worker is idle."].join("\n");
    const block = usabilityGateBlock({ featureId: "f" }, ["docs/26-check-workers.md"], patch);
    expect(block).toContain('approving needs "Real use:');
    expect(block).toContain('docs/26-check-workers.md:42: "Do this soon: until then the worker is idle."');
    expect(usabilityGateBlock({ ownerSetup: "After every runner update, paste the new commit into compose.yaml" }, [], "")).toContain("owner setup:");
    expect(usabilityGateBlock({}, ["src/a.ts"], patch)).toBe("");
  });

  it("owner setup steps that read as a routine duty are warned about, not refused", () => {
    const out = lintOwnerSteps(["After every runner update, open Settings → Server and runner → Checks and press Save."]);
    expect(out.warn.some((w) => /must repeat/.test(w.problem))).toBe(true);
    expect(out.refuse.some((f) => /must repeat/.test(f.problem))).toBe(false);
  });
});

// BOS-2074: a reviewer who calls an owner step wrong can't approve; an approval carries a verdict on the steps.
describe("a reviewer's verdict on the owner setup steps", () => {
  const SETUP = "1. Open Settings → Server and runner → Updates and press Build and update runners.";
  const go = (c: NonNullable<typeof ctx>, id: string, verdict: "approved" | "changes_requested", ownerSteps?: Parameters<NonNullable<typeof ctx>["review"]["submit"]>[1]["ownerSteps"], summary = `Code is clean.\n${WALK}`) =>
    c.review.submit(id, { verdict, summary, ownerSteps, reviewer: "Reviewer", reviewerAgentId: c.reviewer.id, background: true });

  it("refuses an approval with no verdict on the steps, takes 'all needed and correct'", async () => {
    const c = (ctx = await setup());
    const t = await c.raw({ systemState: "review", ownerSetup: SETUP });
    await c.slot(t.id);
    await expect(go(c, t.id, "approved")).rejects.toThrow(/owner setup steps/);
    await expect(go(c, t.id, "approved", [])).rejects.toThrow(/owner setup steps/);
    await expect(go(c, t.id, "approved", "all needed and correct")).resolves.toBeTruthy();
  });

  it("refuses an approval that lists a wrong step, and changes_requested carries the list", async () => {
    const c = (ctx = await setup());
    const t = await c.raw({ systemState: "review", ownerSetup: SETUP });
    await c.slot(t.id);
    await expect(go(c, t.id, "approved", [{ step: "Step 1", why: "not needed" }])).rejects.toThrow(/wrong or not needed/);
    await go(c, t.id, "changes_requested", [{ step: "Step 1", why: "not needed" }], "Fix it.");
    const [row] = await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id));
    expect(row!.status).toBe("changes_requested");
    expect(row!.notes).toContain("Step 1: not needed");
  });

  it("a ticket with no owner setup, or a security review, needs no verdict", async () => {
    const c = (ctx = await setup());
    const t = await c.raw({ systemState: "review" });
    await c.slot(t.id);
    await expect(go(c, t.id, "approved")).resolves.toBeTruthy();
    const s = await c.raw({ systemState: "review", ownerSetup: SETUP });
    await c.slot(s.id, "security");
    await expect(c.review.submit(s.id, { verdict: "approved", summary: "No findings.", kind: "security", reviewer: "Reviewer", reviewerAgentId: c.reviewer.id, background: true })).resolves.toBeTruthy();
  });
});
