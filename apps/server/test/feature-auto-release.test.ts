// BOS-2686: the feature release rule, one ordered table (syncFeature), and the go-live calls that make it run.
//   1. declined: unchanged.
//   2. every delivery ticket done and live: released.
//   3. released, and a delivery ticket open: in progress (a follow-up never reopens it).
//   4. a delivery ticket in progress or review: in progress.
//   5. otherwise: unchanged.
// A delivery ticket is one on the feature from before it first went live; later tickets are follow-ups, and plan and
// design tickets are not delivery work.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, features, runners, settings, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { feedbackService, isDeliveryTicket, liveBaselineOf } from "../src/services/feedback.js";

let server: Awaited<ReturnType<typeof boot>>;

async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return { built, db, close, base, cookie, companies: 0 };
}

/**
 * A fresh company per test. `own: true` gives a company that puts its own work live (its merges wait for its CEO's
 * mark); the default is the home company, whose merges go live with the Boss Man server update.
 */
async function setup(opts: { own?: boolean } = {}) {
  const { built, db, base, cookie } = server;
  const clients: Client[] = [];
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const n = ++server.companies;
  const co = (await req("POST", "/api/companies", { name: `Release Co ${n}` })).json() as { company: { id: string }; ceo: { id: string } };
  if (!opts.own) await db.update(companies).set({ createdAt: new Date(Date.UTC(1990, 0, 1) - n * 1000) }).where(eq(companies.id, co.company.id));
  else await db.insert(companies).values({ name: `Home before ${n}`, createdAt: new Date(Date.UTC(1980, 0, 1) - n * 1000) });
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  const feedback = feedbackService(db);
  const feature = async (patch: Record<string, unknown> = {}) => (await db.insert(features).values({ companyId: co.company.id, title: `Feature ${randomUUID().slice(0, 6)}`, status: "planned", ...patch }).returning())[0]!;
  // A ticket dated as if created at `at`; the feature's baseline is compared with createdAt, so tests say when.
  const ticket = async (patch: Record<string, unknown> = {}, at = new Date("2026-11-01T00:00:00Z")) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Backfill features", systemState: "ready", noCode: true, assigneeAgentId: dev.id, createdAt: at, ...patch }).returning())[0]!;
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const feat = async (id: string) => (await db.select().from(features).where(eq(features.id, id)))[0]!;
  const agent = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const done = async () => void (await Promise.all(clients.map((c) => c.close())));
  return { built, db, req, co, dev, project, reg, feedback, feature, ticket, row, feat, agent, done };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
/** Records the commit the server runs, the way release-log does (BOS-284). */
const serverRuns = (commit: string) => ctx.db.insert(settings).values({ key: `live_release:${ctx.co.company.id}`, value: { old: commit, new: commit } }).onConflictDoUpdate({ target: settings.key, set: { value: { old: commit, new: commit } } });
const OLD = "a".repeat(40);
const NEW = "c".repeat(40);

/**
 * A ticket merged as `commit` and nothing more: the stored state a merge leaves (mergeCommit, and the go-live wait a
 * deployment code change gets). The gate itself is exercised in go-live-wait.test.ts; here the rule table is the subject.
 */
async function merged(patch: Record<string, unknown> = {}, at = new Date("2026-11-01T00:00:00Z")) {
  const t = await ctx.ticket({ systemState: "blocked", mergeCommit: NEW, mergedAt: at, touchesRunner: false, goLiveWait: "server", ...patch }, at);
  return t;
}

beforeAll(async () => {
  server = await boot();
}, 120_000);
afterAll(async () => {
  await server.built.app.close();
  await server.close();
});
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.done();
});

describe("the rule table's helpers", () => {
  it("a plan or design ticket is never delivery work, and a ticket after the feature was live is a follow-up", () => {
    const base = new Date("2026-11-10T00:00:00Z");
    const early = { createdAt: new Date("2026-11-01T00:00:00Z"), title: "Dark mode", planFirst: false };
    const late = { createdAt: new Date("2026-11-20T00:00:00Z"), title: "Tidy the copy", planFirst: false };
    expect(isDeliveryTicket(early, base)).toBe(true);
    expect(isDeliveryTicket(early, null)).toBe(true);
    expect(isDeliveryTicket(late, base)).toBe(false);
    expect(isDeliveryTicket(late, null)).toBe(true);
    expect(isDeliveryTicket({ ...early, title: "Plan (dark mode)" }, base)).toBe(false);
    expect(isDeliveryTicket({ ...early, title: "Design: the toggle" }, base)).toBe(false);
    expect(isDeliveryTicket({ ...early, planFirst: true }, base)).toBe(false);
    // The baseline is the earliest go-live among delivery tickets, and plan tickets don't count.
    expect(liveBaselineOf([{ ...early, liveAt: new Date("2026-11-05T00:00:00Z"), liveMarkedAt: null }, { ...late, liveAt: new Date("2026-11-15T00:00:00Z"), liveMarkedAt: null }])).toEqual(new Date("2026-11-05T00:00:00Z"));
    expect(liveBaselineOf([{ ...early, liveAt: null, liveMarkedAt: new Date("2026-11-06T00:00:00Z") }])).toEqual(new Date("2026-11-06T00:00:00Z"));
    expect(liveBaselineOf([{ ...early, liveAt: null, liveMarkedAt: null }])).toBeNull();
  });
});

describe("syncFeature: the ordered rule table", () => {
  it("rule 1: a declined feature is never touched", async () => {
    const f = await ctx.feature({ status: "declined" });
    await ctx.ticket({ featureId: f.id, systemState: "done" });
    expect(await ctx.feedback.syncFeature(f.id)).toBeNull();
    expect((await ctx.feat(f.id)).status).toBe("declined");
  });

  it("rule 2: released when every delivery ticket is done and live", async () => {
    await serverRuns(NEW);
    const f = await ctx.feature();
    const a = await merged({ featureId: f.id, systemState: "done" });
    await merged({ featureId: f.id, systemState: "done" });
    const u = await ctx.feedback.syncFeature(f.id);
    expect(u?.status).toBe("released");
    expect((await ctx.feat(f.id)).releasedAt).not.toBeNull();
    // The feature's first go-live is recorded as its baseline.
    expect((await ctx.feat(f.id)).liveBaselineAt).not.toBeNull();
    expect(a.id).toBeTruthy();
  });

  it("rule 2: a done ticket that isn't live yet does not release it", async () => {
    await serverRuns(OLD);
    const f = await ctx.feature();
    await merged({ featureId: f.id, systemState: "done" });
    expect(await ctx.feedback.syncFeature(f.id)).toBeNull();
    expect((await ctx.feat(f.id)).status).toBe("planned");
    // The server runs it: released.
    await serverRuns(NEW);
    expect((await ctx.feedback.syncFeature(f.id))?.status).toBe("released");
  });

  it("rule 3: a follow-up filed on a released feature leaves it released (regression)", async () => {
    await serverRuns(NEW);
    const f = await ctx.feature();
    const shipped = await merged({ featureId: f.id, systemState: "done" });
    expect((await ctx.feedback.syncFeature(f.id))?.status).toBe("released");
    const baseline = (await ctx.feat(f.id)).liveBaselineAt!;
    expect(baseline).not.toBeNull();
    expect(shipped.liveAt ?? shipped.mergedAt).toBeTruthy();
    // A follow-up: created after it went live, on the feature, and in progress.
    await ctx.feedback.syncFeature(f.id);
    const late = await ctx.ticket({ featureId: f.id, systemState: "in_progress", createdAt: new Date(baseline.getTime() + 86_400_000) });
    expect(await ctx.feedback.syncFeature(f.id)).toBeNull();
    expect((await ctx.feat(f.id)).status).toBe("released");
    expect(late.featureId).toBe(f.id);
  });

  it("rule 3: a 27/28 feature whose one open ticket is a follow-up shows released (regression)", async () => {
    await serverRuns(NEW);
    const f = await ctx.feature();
    for (let i = 0; i < 26; i++) await merged({ featureId: f.id, systemState: "done" }, new Date(Date.UTC(2026, 10, 1, i)));
    await merged({ featureId: f.id, systemState: "done" }, new Date(Date.UTC(2026, 10, 2)));
    expect((await ctx.feedback.syncFeature(f.id))?.status).toBe("released");
    const baseline = (await ctx.feat(f.id)).liveBaselineAt!;
    // 27 of 28 done; the 28th is a follow-up the team files after it went live, still in Ready.
    await ctx.ticket({ featureId: f.id, systemState: "ready", createdAt: new Date(baseline.getTime() + 3_600_000) });
    expect(await ctx.feedback.syncFeature(f.id)).toBeNull();
    expect((await ctx.feat(f.id)).status).toBe("released");
  });

  it("rule 4: a plan ticket alone does not move a planned feature to in progress (regression)", async () => {
    const f = await ctx.feature({ status: "planned" });
    await ctx.ticket({ featureId: f.id, title: "Plan (dark mode)", planFirst: true, systemState: "in_progress" });
    expect(await ctx.feedback.syncFeature(f.id)).toBeNull();
    expect((await ctx.feat(f.id)).status).toBe("planned");
    // A real delivery ticket in progress does move it.
    await ctx.ticket({ featureId: f.id, systemState: "in_progress" });
    expect((await ctx.feedback.syncFeature(f.id))?.status).toBe("in_progress");
  });

  it("rule 4: delivery work in review moves a considering feature to in progress; rule 5 leaves it alone otherwise", async () => {
    const f = await ctx.feature({ status: "considering" });
    await ctx.ticket({ featureId: f.id, systemState: "review" });
    expect((await ctx.feedback.syncFeature(f.id))?.status).toBe("in_progress");
    // An open delivery ticket that is only Ready (rule 5) leaves an in-progress feature as it is.
    const g = await ctx.feature({ status: "in_progress" });
    await ctx.ticket({ featureId: g.id, systemState: "ready" });
    expect(await ctx.feedback.syncFeature(g.id)).toBeNull();
    expect((await ctx.feat(g.id)).status).toBe("in_progress");
  });

  it("rule 2 + 3: an open delivery ticket keeps a released feature in progress", async () => {
    await serverRuns(NEW);
    const f = await ctx.feature();
    await merged({ featureId: f.id, systemState: "done" });
    expect((await ctx.feedback.syncFeature(f.id))?.status).toBe("released");
    const baseline = (await ctx.feat(f.id)).liveBaselineAt!;
    // A ticket from before it went live is still open (a real delivery promise): it reopens it.
    const early = await ctx.ticket({ featureId: f.id, systemState: "in_progress", createdAt: new Date(baseline.getTime() - 86_400_000) });
    expect((await ctx.feedback.syncFeature(f.id))?.status).toBe("in_progress");
    // Once that one is done and live too, released again.
    await ctx.db.update(tickets).set({ systemState: "done", mergeCommit: NEW, mergedAt: new Date(), goLiveWait: null }).where(eq(tickets.id, early.id));
    expect((await ctx.feedback.syncFeature(f.id))?.status).toBe("released");
  });
});

describe("the merge/ticket events keep the table up to date", () => {
  it("a ticket moving to done on an unreleased feature releases it through the app's own hook", async () => {
    await serverRuns(NEW);
    const f = await ctx.feature({ status: "in_progress" });
    const t = await ctx.ticket({ featureId: f.id, systemState: "review", mergeCommit: NEW, mergedAt: new Date(), goLiveWait: null, noCode: false });
    expect((await ctx.feat(f.id)).status).toBe("in_progress");
    await ctx.req("PATCH", `/api/tickets/${t.id}`, { state: "done" });
    expect((await ctx.feat(f.id)).status).toBe("released");
  });
});

describe("the go-live hook (this company puts its own work live)", () => {
  beforeEach(async () => {
    ctx = await setup({ own: true });
  });

  it("the CEO marking a merge live releases the feature its ticket delivers", async () => {
    const ceo = await ctx.agent(ctx.co.ceo.id);
    const f = await ctx.feature({ status: "in_progress" });
    const t = await ctx.ticket({ featureId: f.id, systemState: "blocked", mergeCommit: NEW, mergedAt: new Date(), touchesRunner: false, goLiveWait: "own" });
    expect((await ctx.feat(f.id)).status).toBe("in_progress");
    const out = textOf(await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, markLive: "Their release script put it live", reason: "It is live" } }));
    expect(out).toContain("Marked live");
    // The ticket is not done yet, so the feature waits for it to close (rule 4 keeps it), but it is now live.
    expect((await ctx.row(t.id)).liveMarkedAt).not.toBeNull();
    expect((await ctx.feat(f.id)).liveBaselineAt).not.toBeNull();
    // Once the ticket is done, the feature's release rule sees it live without another go-live event.
    await ctx.db.update(tickets).set({ systemState: "done", goLiveWait: null }).where(eq(tickets.id, t.id));
    expect((await ctx.feedback.syncFeature(f.id))?.status).toBe("released");
  });
});
