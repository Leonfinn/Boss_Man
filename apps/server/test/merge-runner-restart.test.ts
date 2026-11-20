// DR-014 (BOS-452): a runner restart fails its in-flight merge requests at once, and merges run again by themselves.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { setInfraRetryBase } from "../src/services/review.js";
import { RunnerGone } from "../src/services/runners.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const DIFF = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/x b/x", truncated: false };
const never = new Promise<void>(() => {});

async function setup() {
  setInfraRetryBase(1);
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const clients: Client[] = [];
  ctx = { close: async () => (await Promise.all(clients.map((c) => c.close())), await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  /** What the fake runner does with each kind of request; a held one never answers, like a runner that was swapped. */
  const behave = { verify: () => Promise.resolve() as Promise<void>, merge: () => Promise.resolve() as Promise<void>, running: 0, maxRunning: 0, lockedDiffs: 0 };
  const connect = () =>
    built.runners.connect(reg.runnerId, (c) => {
      sent.push(c);
      const requestId = (c as { requestId: string }).requestId;
      const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId, ok: true, data }));
      if (c.type === "workspace.diff") {
        // BOS-2089: a restarted runner whose repo lock is still held answers every diff with the lock time-out.
        if (behave.lockedDiffs > 0) {
          behave.lockedDiffs--;
          queueMicrotask(() => built.runners.resolveReply({ requestId, ok: false, error: `Timed out waiting for the lock on ${project.id}.` }));
        } else ok(DIFF);
      }
      if (c.type === "workspace.carried") ok({ carried: [] });
      if (c.type === "workspace.migrations") ok({ needed: false, reason: "none" });
      if (c.type === "workspace.verify") {
        behave.running++;
        behave.maxRunning = Math.max(behave.maxRunning, behave.running);
        void behave.verify().then(() => {
          behave.running--;
          ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
        });
      }
      if (c.type === "workspace.merge") void behave.merge().then(() => ok({ status: "merged", commit: "c".repeat(40) }));
      return true;
    }, ["carried-check"]);
  const ticket = async () => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, systemState: "review" }).where(eq(tickets.id, t.id));
    return t;
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const ceoClient = async () => {
    const token = await issueRunToken(db, { companyId: company.id, agentId: ceo.id, runId: crypto.randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(built.app.server.address() as { port: number }).port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { db, built, req, company, project, runner: runner!, runnerId: reg.runnerId as string, sent, behave, connect, ticket, row, ceoClient };
}

describe("a runner restart fails what it was handling", () => {
  it("rejects every pending request with RunnerGone the moment the runner disconnects", async () => {
    const c = await setup();
    const drop = c.built.runners.connect(c.runnerId, () => true);
    const a = c.built.runners.request(c.runnerId, (requestId) => ({ type: "addons.check", requestId }), 60_000);
    const b = c.built.runners.request(c.runnerId, (requestId) => ({ type: "addons.check", requestId }), 60_000);
    const failed = Promise.allSettled([a, b]);
    drop();
    const results = await failed;
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RunnerGone);
    }
  });

  it("rejects pending requests when the runner says hello with a new boot id", async () => {
    const c = await setup();
    c.built.runners.connect(c.runnerId, () => true);
    await c.built.runners.bootSeen(c.runner, "boot-1");
    const [fresh] = await c.db.select().from(runners).where(eq(runners.id, c.runnerId));
    const pending = c.built.runners.request(c.runnerId, (requestId) => ({ type: "addons.check", requestId }), 60_000);
    const settled = Promise.allSettled([pending]);
    await c.built.runners.bootSeen(fresh!, "boot-2");
    const [r] = await settled;
    expect(r!.status).toBe("rejected");
    expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RunnerGone);
  });

  it("runs a merge again by itself after the runner restarts under it, with no card raised", async () => {
    const c = await setup();
    let first = true;
    c.behave.merge = () => (first ? ((first = false), never) : Promise.resolve());
    const drop = c.connect();
    const t = await c.ticket();
    const landed = c.built.review.landVisible(t.id, "the owner");
    await vi.waitFor(() => expect(c.sent.filter((x) => x.type === "workspace.merge")).toHaveLength(1));
    // The swap: the old runner goes, the new one connects.
    drop();
    c.connect();
    await landed;
    expect((await c.row(t.id)).systemState).toBe("done");
    expect(c.sent.filter((x) => x.type === "workspace.merge")).toHaveLength(2);
    expect((await c.db.query.decisions.findMany()).filter((d) => (d.context as { ticketId?: string }).ticketId === t.id)).toHaveLength(0);
  });

  it("keeps merging after a swap when the sign-off was already given: the check is rerun and the ticket lands", async () => {
    const c = await setup();
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    let first = true;
    c.behave.verify = () => (first ? ((first = false), never) : Promise.resolve());
    const drop = c.connect();
    const t = await c.ticket();
    const landed = c.built.review.landVisible(t.id, "the owner");
    await vi.waitFor(() => expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(1));
    drop();
    c.connect();
    await landed;
    expect((await c.row(t.id)).systemState).toBe("done");
    expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(2);
  });

  it("27 queued merges survive a runner swap: every one still runs, two at a time", async () => {
    const c = await setup();
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    const first = { done: false };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The first two checks are lost with the old runner; every later one finishes when released.
    let n = 0;
    c.behave.verify = () => (n++ < 2 ? never : gate);
    const drop = c.connect();
    const ids: string[] = [];
    for (let i = 0; i < 27; i++) ids.push((await c.ticket()).id);
    const landings = ids.map((id) => c.built.review.landVisible(id, "the owner").catch((e: Error) => e));
    await vi.waitFor(() => expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(2));
    drop();
    // The old runner took its two running checks with it.
    c.behave.running = 0;
    c.connect();
    first.done = true;
    // The two lost checks are retried and the other 25 take their turns, never more than two at once.
    await vi.waitFor(() => expect(c.behave.running).toBe(2));
    release();
    await Promise.all(landings);
    for (const id of ids) expect((await c.row(id)).systemState).toBe("done");
    expect(c.behave.maxRunning).toBeLessThanOrEqual(2);
  }, 60_000);

  it("a runner that stays away longer than every retry pause: merges wait, then land in order, no card, two at a time", async () => {
    const c = await setup();
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The first two checks die with the old runner; later ones finish when released.
    c.behave.verify = () => (n++ < 2 ? never : gate);
    const drop = c.connect();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await c.ticket()).id);
    const landings = ids.map((id) => c.built.review.landVisible(id, "the owner").catch((e: Error) => e));
    await vi.waitFor(() => expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(2));
    drop();
    c.behave.running = 0;
    // Away for far longer than all three retry pauses (1 + 2 + 4 ms): no try may be used up and no request sent meanwhile.
    const before = c.sent.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(c.sent.length).toBe(before);
    c.connect();
    await vi.waitFor(() => expect(c.behave.running).toBe(2), { timeout: 3000 });
    release();
    await Promise.all(landings);
    for (const id of ids) expect((await c.row(id)).systemState).toBe("done");
    expect(c.behave.maxRunning).toBeLessThanOrEqual(2);
    expect(await c.db.query.decisions.findMany()).toHaveLength(0);
  }, 60_000);
});

describe("a runner still catching up after a restart (BOS-2089)", () => {
  const cards = async (c: Awaited<ReturnType<typeof setup>>, id: string) => (await c.db.query.decisions.findMany()).filter((d) => (d.context as { ticketId?: string }).ticketId === id);

  it("20 Nov: the diff hits the held repo lock more times than the retry budget, and the merge still lands with no card", async () => {
    const c = await setup();
    // 14:09-14:15 on 20 Nov: four tries in a row failed this way, then the card. Here it fails six times.
    c.behave.lockedDiffs = 6;
    c.connect();
    const t = await c.ticket();
    await c.built.review.landVisible(t.id, "the owner");
    expect((await c.row(t.id)).systemState).toBe("done");
    expect(c.sent.filter((x) => x.type === "workspace.diff").length).toBeGreaterThanOrEqual(7);
    expect(await cards(c, t.id)).toHaveLength(0);
    // Each failed try keeps the runner's own reason, so the next one of these can be explained from the records.
    const fails = (await c.db.query.activity.findMany()).filter((a) => a.ticketId === t.id && (a.detail as { event?: string } | null)?.event === "attempt_failed");
    expect(fails).toHaveLength(6);
    for (const f of fails) expect(f.detail).toMatchObject({ reason: "restart", note: expect.stringContaining("Timed out waiting for the lock") });
  });

  it("a runner that has been back a while and still fails: the card comes after the usual tries", async () => {
    const c = await setup();
    c.behave.lockedDiffs = 100;
    c.connect();
    vi.spyOn(c.built.runners, "isSettling").mockReturnValue(false);
    const t = await c.ticket();
    await c.built.review.landVisible(t.id, "the owner").catch(() => undefined);
    // One try plus INFRA_RETRY_ATTEMPTS (3) retries, as before.
    expect(c.sent.filter((x) => x.type === "workspace.diff")).toHaveLength(4);
    expect(await cards(c, t.id)).toHaveLength(1);
    expect((await c.row(t.id)).systemState).toBe("review");
  });

  it("a runner that keeps reconnecting still ends at a card: uncounted tries are capped", async () => {
    const c = await setup();
    c.behave.lockedDiffs = 100;
    c.connect();
    const t = await c.ticket();
    await c.built.review.landVisible(t.id, "the owner").catch(() => undefined);
    // SETTLE_FREE_TRIES (8) uncounted, then the usual 3 retries: 1 + 8 + 3 diffs.
    expect(c.sent.filter((x) => x.type === "workspace.diff")).toHaveLength(12);
    expect(await cards(c, t.id)).toHaveLength(1);
  });
});

describe("merge state on card lists", () => {
  it("names the merge's place: checking while the check runs, then finished", async () => {
    const c = await setup();
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    let release!: () => void;
    c.behave.verify = () => new Promise<void>((r) => (release = r));
    c.connect();
    const t = await c.ticket();
    const landed = c.built.review.landVisible(t.id, "the owner");
    await vi.waitFor(() => expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(1));
    expect(await c.built.review.mergeState(t.id)).toMatch(/^merge checking \(since \d\d:\d\d UTC\)$/);
    expect((await c.built.review.landing(t.id))).toMatchObject({ state: "running", phase: "checking" });
    // The ticket read tool carries the same line.
    const ceo = await c.ceoClient();
    const read = (await ceo.callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id } })) as { content: Array<{ text: string }> };
    expect(read.content[0]!.text).toContain("Merge state: merge checking");
    release();
    await landed;
  });
});
