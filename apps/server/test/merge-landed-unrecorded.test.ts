// BOS-1647: a push to the default branch that landed but was never recorded is recorded by the retry or the sweep,
// with the commit that brought the head in: no second push, no bounce, even when the ticket left review meanwhile.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, reviewRequests, runners, tickets } from "../src/db/schema.js";
import { setInfraRetryBase } from "../src/services/review.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const HEAD = "b".repeat(40);
const MERGE = "d".repeat(40);
const WORK = { baseCommit: "a".repeat(40), head: HEAD, commits: [{ sha: HEAD, subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/x b/x", truncated: false };
/** What the runner reports once the push landed: the head is inside main, so nothing is left to diff. */
const LANDED = { baseCommit: HEAD, head: HEAD, commits: [], files: [], diff: "", truncated: false, mergedInto: { commit: MERGE, files: ["src/a.ts"] } };

async function setup() {
  setInfraRetryBase(1);
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
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
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  const state = { diff: LANDED as object };
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    const requestId = (c as { requestId: string }).requestId;
    const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId, ok: true, data }));
    if (c.type === "workspace.diff") ok(state.diff);
    if (c.type === "workspace.carried") ok({ carried: [] });
    if (c.type === "workspace.migrations") ok({ needed: false, reason: "none" });
    if (c.type === "workspace.verify") ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
    if (c.type === "workspace.merge") ok({ status: "merged", commit: "c".repeat(40) });
    return true;
  }, ["carried-check"]);
  /** A ticket whose review passed on HEAD, in the given state. */
  const approved = async (systemState: string) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, systemState: systemState as "review" }).where(eq(tickets.id, t.id));
    await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: worker.id, round: 1, seq: 0, status: "approved", decidedAt: new Date(Date.now() - 60 * 60_000), head: HEAD });
    return t;
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const asked = (type: string) => sent.filter((x) => x.type === type).length;
  return { db, built, runner: runner!, sent, state, approved, row, asked };
}

describe("a landed push that was never recorded (BOS-1647)", () => {
  it("the retried merge records the commit that brought the head in: no push, no bounce", async () => {
    const c = await setup();
    const t = await c.approved("review");
    const r = await c.built.review.land(t.id, "the owner");
    expect(r.outcome).toBe("merged");
    const after = await c.row(t.id);
    expect(after.mergeCommit).toBe(MERGE);
    expect(after.mergedAt).not.toBeNull();
    expect(after.systemState).toBe("done");
    expect(c.asked("workspace.merge")).toBe(0);
    expect(c.asked("workspace.verify")).toBe(0);
    const lines = await c.db.select().from(activity).where(eq(activity.ticketId, t.id));
    expect(lines.some((l) => l.kind === "merge_recorded")).toBe(true);
    // The author was not sent a "nothing changed" bounce.
    expect(lines.some((l) => /nothing changed/i.test(l.summary))).toBe(false);
  });

  it.each(["in_progress", "blocked"])("the sweep records it when the ticket has left review (%s)", async (state) => {
    const c = await setup();
    const t = await c.approved(state);
    await c.built.sweeps.run();
    const after = await c.row(t.id);
    expect(after.mergeCommit).toBe(MERGE);
    expect(after.mergedAt).not.toBeNull();
    expect(c.asked("workspace.merge")).toBe(0);
  });

  it("leaves a ticket alone whose head is not on main", async () => {
    const c = await setup();
    c.state.diff = WORK;
    const t = await c.approved("in_progress");
    await c.built.sweeps.run();
    const after = await c.row(t.id);
    expect(after.mergeCommit).toBeNull();
    expect(after.systemState).toBe("in_progress");
    expect(c.asked("workspace.merge")).toBe(0);
  });

  it("leaves a ticket alone when main has a different head than the one reviewed", async () => {
    const c = await setup();
    c.state.diff = { ...LANDED, head: "e".repeat(40), mergedInto: { commit: MERGE } };
    const t = await c.approved("blocked");
    await c.built.sweeps.run();
    expect((await c.row(t.id)).mergeCommit).toBeNull();
  });
});
