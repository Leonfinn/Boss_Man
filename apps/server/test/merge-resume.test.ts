// DR-026 (BOS-539): a server that takes charge restarts approved, unmerged merges at once; a demoted copy stops its merges quietly.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, companies, decisions, reviewRequests, runners, settings, tickets } from "../src/db/schema.js";
import { createLeader } from "../src/leader.js";
import { MAINTENANCE_KEY } from "../src/services/maintenance.js";
import { setInfraRetryBase } from "../src/services/review.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const DIFF = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/x b/x", truncated: false };
const never = new Promise<void>(() => {});
const MIN = 60_000;

async function setup() {
  setInfraRetryBase(1);
  const { db, close } = await openPglite();
  const lead = { on: true };
  const leader = { ...createLeader(), isLeader: () => lead.on };
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", leader });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const sent: RunnerCommand[] = [];
  const behave = { merge: () => Promise.resolve() as Promise<void> };
  const connect = () =>
    built.runners.connect(reg.runnerId, (c) => {
      sent.push(c);
      const requestId = (c as { requestId: string }).requestId;
      const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId, ok: true, data }));
      if (c.type === "workspace.diff") ok(DIFF);
      if (c.type === "workspace.carried") ok({ carried: [] });
      if (c.type === "workspace.migrations") ok({ needed: false, reason: "none" });
      if (c.type === "workspace.verify") ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
      if (c.type === "workspace.merge") void behave.merge().then(() => ok({ status: "merged", commit: "c".repeat(40) }));
      return true;
    }, ["carried-check"]);
  /** A ticket in review whose only review passed `agoMs` ago. */
  const approved = async (agoMs: number, fields: Record<string, unknown> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, ...fields })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, systemState: "review", ...(fields.urgent ? { urgent: true } : {}) }).where(eq(tickets.id, t.id));
    await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: worker.id, round: 1, seq: 0, status: "approved", decidedAt: new Date(Date.now() - agoMs) });
    return t;
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  return { db, built, company, lead, req, sent, behave, connect, approved, row };
}

describe("a server that takes charge restarts approved merges (DR-026)", () => {
  it("starts a ticket approved 5 minutes ago at once, and leaves a ticket line, not a card", async () => {
    const c = await setup();
    c.connect();
    const t = await c.approved(5 * MIN);
    // The 66-minute sweep leaves it alone...
    expect(await c.built.sweeps.run()).toMatchObject({ unmergedApprovals: 0 });
    // ...but the pass on promotion starts it.
    expect(await c.built.sweeps.resumeMergesOnPromotion(new Date())).toEqual({ started: 1, waiting: 0 });
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    const lines = await c.db.select().from(activity).where(eq(activity.ticketId, t.id));
    expect(lines.some((l) => l.summary.includes("The server restarted during this merge, so it was started again"))).toBe(true);
    expect(await c.db.select().from(decisions)).toHaveLength(0);
  });

  it("starts the urgent ticket first, then the rest by approval time", async () => {
    const c = await setup();
    c.connect();
    const older = await c.approved(30 * MIN);
    const newer = await c.approved(5 * MIN);
    const urgent = await c.approved(2 * MIN, { urgent: true });
    const order: string[] = [];
    const real = c.built.review.startLanding.bind(c.built.review);
    vi.spyOn(c.built.review, "startLanding").mockImplementation(async (id, ...rest) => (order.push(id), real(id, ...rest)));
    await c.built.sweeps.resumeMergesOnPromotion(new Date());
    expect(order).toEqual([urgent.id, older.id, newer.id]);
  });

  it("waits while the update hold is on, then starts both", async () => {
    const c = await setup();
    c.connect();
    const a = await c.approved(10 * MIN);
    const b = await c.approved(5 * MIN);
    const hold = { reason: "update pending", since: new Date().toISOString(), deadline: new Date(Date.now() + 60 * MIN).toISOString(), minutes: 60 };
    await c.db.insert(settings).values({ key: MAINTENANCE_KEY, value: hold });
    const promoted = new Date();
    expect(await c.built.sweeps.resumeMergesOnPromotion(promoted)).toEqual({ started: 0, waiting: 1 });
    expect(c.sent.filter((x) => x.type === "workspace.merge")).toHaveLength(0);
    await c.db.delete(settings).where(eq(settings.key, MAINTENANCE_KEY));
    expect(await c.built.sweeps.resumeMergesOnPromotion(promoted)).toEqual({ started: 2, waiting: 0 });
    await vi.waitFor(async () => expect([(await c.row(a.id)).systemState, (await c.row(b.id)).systemState]).toEqual(["done", "done"]));
  });

  it("waits for the company's runner to connect, and skips what must not start", async () => {
    const c = await setup();
    const t = await c.approved(5 * MIN);
    expect(await c.built.sweeps.resumeMergesOnPromotion(new Date())).toEqual({ started: 0, waiting: 1 });
    c.connect();
    // An approval made after this server took charge is the live merge path's, not the resume pass's.
    const promoted = new Date(Date.now() - 10 * MIN);
    expect(await c.built.sweeps.resumeMergesOnPromotion(promoted)).toEqual({ started: 0, waiting: 0 });
    // An open merge-stuck card, and a paused company, keep a ticket out.
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "q", options: ["Run the check again"], recommendedOption: "Run the check again", tier: "owner", status: "open", dedupeKey: `merge-stuck:${t.id}`, context: { type: "check_stuck", ticketId: t.id } });
    expect(await c.built.sweeps.resumeMergesOnPromotion(new Date())).toEqual({ started: 0, waiting: 0 });
    await c.db.delete(decisions).where(eq(decisions.dedupeKey, `merge-stuck:${t.id}`));
    await c.db.update(companies).set({ paused: true }).where(eq(companies.id, c.company.id));
    expect(await c.built.sweeps.resumeMergesOnPromotion(new Date())).toEqual({ started: 0, waiting: 0 });
    expect(c.sent.filter((x) => x.type === "workspace.merge")).toHaveLength(0);
  });
});

describe("a demoted copy stops its merges quietly (DR-026)", () => {
  it("records the hand-over, retries nothing and raises no card when the runner goes under a merge", async () => {
    const c = await setup();
    c.behave.merge = () => never;
    const drop = c.connect();
    const t = await c.approved(MIN);
    const landed = c.built.review.landVisible(t.id, "the owner");
    await vi.waitFor(() => expect(c.sent.filter((x) => x.type === "workspace.merge")).toHaveLength(1));
    // The hand-over: this copy is no longer in charge, and its runner socket closes.
    c.lead.on = false;
    drop();
    const r = await landed;
    expect(r.outcome).toBe("check_stuck");
    expect((await c.row(t.id)).systemState).toBe("review");
    expect(c.sent.filter((x) => x.type === "workspace.merge")).toHaveLength(1);
    expect(await c.db.select().from(decisions).where(and(eq(decisions.status, "open")))).toHaveLength(0);
    const lines = await c.db.select().from(activity).where(eq(activity.ticketId, t.id));
    expect(lines.some((l) => l.summary.includes("cut off by the hand-over"))).toBe(true);
  });
});
