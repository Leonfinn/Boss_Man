// BOS-1021: after-merge checks wait until the merge is live (server) and, for runner code, until the runners
// have it. Nobody is woken, and no owner card is taken, before that.
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RUNNER_CODE_PATHS, touchesRunnerCode } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners, settings, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { type StandInReplies, standInRunner } from "./helpers/stand-in-runner.js";

let server: Awaited<ReturnType<typeof boot>>;
let ctx: Awaited<ReturnType<typeof setup>>;

async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return { built, db, close, base, cookie, companies: 0 };
}

async function setup() {
  const { built, db, base, cookie } = server;
  const clients: Client[] = [];
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: `Live Co ${++server.companies}` })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  const agent = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { ...built, db, req, co, dev, project, reg, agent, row: async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!, done: async () => void (await Promise.all(clients.map((c) => c.close()))) };
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

const mergeReplies = (commit: string, path: string): StandInReplies => ({
  "workspace.diff": { baseCommit: "0".repeat(40), head: "1".repeat(40), commits: [{ sha: "1".repeat(40), subject: "The change" }], files: [{ path, added: 3, removed: 0 }], diff: "", truncated: false },
  "workspace.verify": { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 },
  "workspace.merge": { status: "merged", commit },
  "workspace.carried": { carried: [] },
  "workspace.migrations": { needed: false, reason: "No other branch uses this ticket's migration numbers." },
});

const LIVE = { text: "The panel shows the host on the real server", after: "merge" as const };
const OLD = "a".repeat(40);
const NEW = "c".repeat(40);

/** Records the commit the server runs, the way release-log does. */
const serverRuns = (commit: string) => ctx.db.insert(settings).values({ key: `live_release:${ctx.co.company.id}`, value: { old: commit, new: commit } }).onConflictDoUpdate({ target: settings.key, set: { value: { old: commit, new: commit } } });

/** A ticket in review, approved and merged by the gate as `commit`, touching `path`. */
async function mergeOne(commit: string, path: string, opts: { noFileList?: boolean } = {}) {
  const { db, req, dev, project, co, reg } = ctx;
  const replies = mergeReplies(commit, path);
  if (opts.noFileList) delete replies["workspace.diff"]; // the gate cannot say what changed
  const stand = standInRunner(ctx.runners, reg.runnerId, replies);
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Live panel", assigneeAgentId: dev.id, acceptanceCriteria: [LIVE] })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${t.id}`, systemState: "review" }).where(eq(tickets.id, t.id));
  const r = await ctx.review.landVisible(t.id, "the owner");
  expect(stand).toEqual(opts.noFileList ? ["workspace.diff"] : []);
  expect(co.company.id).toBeTruthy();
  return { id: t.id, r };
}
const afterMergeWakes = async (ticketId: string) => (await ctx.db.select().from(wakes)).filter((w) => w.ticketId === ticketId && w.reason === "after merge");

describe("go-live wait: the pure parts", () => {
  it("runner code paths agree with the deployer's rule", () => {
    const here = new URL("../../..", import.meta.url).pathname;
    const sh = readFileSync(`${here}scripts/host-deployer.sh`, "utf8").match(/^RUNNER_PATHS='([^']*)'/m)![1]!;
    expect(RUNNER_CODE_PATHS.source.replace(/\\\//g, "/")).toBe(sh);
    expect(touchesRunnerCode(["apps/server/src/app.ts", "apps/runner/src/main.ts"])).toBe(true);
    expect(touchesRunnerCode(["apps/server/src/app.ts", "apps/web/src/x.tsx"])).toBe(false);
  });
});

describe("after-merge checks wait for go-live", () => {
  beforeAll(async () => {
    server = await boot();
  });
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

  it("a server change waits for the deploy, wakes once when it is live, and takes no owner card before", { timeout: 120_000 }, async () => {
    await serverRuns(OLD);
    const { id, r } = await mergeOne(NEW, "apps/server/src/app.ts");
    expect(r.outcome).toBe("merged");
    const waiting = await ctx.row(id);
    expect(waiting.goLiveWait).toBe("server");
    expect(waiting.touchesRunner).toBe(false);
    expect(waiting.systemState).toBe("in_progress");
    expect(await afterMergeWakes(id)).toEqual([]);
    // Nothing happens while the old commit runs.
    expect(await ctx.review.releaseGoLiveWaiters(ctx.co.company.id)).toBe(0);
    // The agent can neither ask the owner nor close it yet.
    const c = await ctx.agent(ctx.dev.id);
    const card = textOf(await c.callTool({ name: "raise_decision", arguments: { question: "Does the panel show the host?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: id, criterion: 1, triedFirst: "Looked at it myself; only the owner sees their server.", ownerMustDo: false } }));
    expect(card).toContain("isn't live yet");
    expect(textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: id, state: "done", summary: "1 pass" } }))).toContain("isn't live yet");
    // The deploy lands.
    await serverRuns(NEW);
    expect(await ctx.review.releaseGoLiveWaiters(ctx.co.company.id)).toBe(1);
    expect((await ctx.row(id)).goLiveWait).toBeNull();
    const wakeNotes = await afterMergeWakes(id);
    expect(wakeNotes).toHaveLength(1);
    expect(wakeNotes[0]!.note).toContain(LIVE.text);
    // A second pass doesn't wake again.
    expect(await ctx.review.releaseGoLiveWaiters(ctx.co.company.id)).toBe(0);
    expect(await afterMergeWakes(id)).toHaveLength(1);
  });

  it("runner code waits for the runners as well as the server", { timeout: 120_000 }, async () => {
    await serverRuns(OLD);
    await ctx.db.update(runners).set({ imageCommit: OLD }).where(eq(runners.id, ctx.reg.runnerId));
    const { id } = await mergeOne(NEW, "apps/runner/src/main.ts");
    expect((await ctx.row(id)).goLiveWait).toBe("both");
    await serverRuns(NEW);
    // The server is updated, the runners are not: it keeps waiting, now only for them.
    expect(await ctx.review.releaseGoLiveWaiters(ctx.co.company.id)).toBe(0);
    expect((await ctx.row(id)).goLiveWait).toBe("runner");
    expect(await afterMergeWakes(id)).toEqual([]);
    await ctx.db.update(runners).set({ imageCommit: NEW }).where(eq(runners.id, ctx.reg.runnerId));
    expect(await ctx.review.releaseGoLiveWaiters(ctx.co.company.id)).toBe(1);
    expect(await afterMergeWakes(id)).toHaveLength(1);
  });

  it("no owner card of any kind on a merged ticket that isn't live, including one merged before the wait existed", { timeout: 120_000 }, async () => {
    const { db, req, dev, project } = ctx;
    const mk = async (commit: string, at: string) => {
      const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `T ${commit.slice(0, 1)}`, assigneeAgentId: dev.id })).json() as { id: string };
      await db.update(tickets).set({ mergeCommit: commit, mergedAt: new Date(at), systemState: "in_progress" }).where(eq(tickets.id, t.id));
      return t.id;
    };
    await mk(OLD, "2026-11-01T00:00:00Z");
    const old = await mk(NEW, "2026-11-02T00:00:00Z"); // no go_live_wait flag: a row from before this change
    await serverRuns(OLD);
    const c = await ctx.agent(ctx.dev.id);
    const ask = { question: "Is the new thing live?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: old, triedFirst: "Looked at it myself; only the owner sees their server.", ownerMustDo: false };
    expect(textOf(await c.callTool({ name: "raise_decision", arguments: ask }))).toContain("isn't live yet");
    await serverRuns(NEW);
    expect(textOf(await c.callTool({ name: "raise_decision", arguments: ask }))).not.toContain("isn't live yet");
  });

  it("a merge whose changed files are unknown waits for the server and the runners", { timeout: 120_000 }, async () => {
    await serverRuns(OLD);
    await ctx.db.update(runners).set({ imageCommit: OLD }).where(eq(runners.id, ctx.reg.runnerId));
    const { id, r } = await mergeOne(NEW, "apps/web/src/x.tsx", { noFileList: true });
    expect(r.outcome).toBe("merged");
    const t = await ctx.row(id);
    expect(t.touchesRunner).toBe(true);
    expect(t.goLiveWait).toBe("both");
    await serverRuns(NEW);
    expect(await ctx.review.releaseGoLiveWaiters(ctx.co.company.id)).toBe(0);
    expect((await ctx.row(id)).goLiveWait).toBe("runner");
  });

  it("a merge that is already live is handed to the assignee at once, as before", { timeout: 120_000 }, async () => {
    await serverRuns(NEW);
    const { id } = await mergeOne(NEW, "apps/server/src/app.ts");
    expect((await ctx.row(id)).goLiveWait).toBeNull();
    expect(await afterMergeWakes(id)).toHaveLength(1);
  });

  // BOS-1037: a hand-apply (the one-time escape for an infra change) restarts the server on the new commit, but
  // Boss Man's live-commit record (live_release:*) is only written by the deployer's own reports. The restarted
  // server, built from the new commit, must record that it runs it, or every merge that waits for go-live stays
  // stuck: "This ticket's merge isn't live yet" even though the host runs it.
  it("a server restarted by a hand-apply records its own commit as live, so later merges stop waiting for it", { timeout: 120_000 }, async () => {
    // Approved and merged while the previous commit runs: it waits for the server update.
    await serverRuns(OLD);
    const { id } = await mergeOne(NEW, "scripts/host-deployer.sh");
    expect((await ctx.row(id)).goLiveWait).toBe("server");
    // The owner hand-applied it: the restarted process was built from NEW and says so on its own build.
    vi.stubEnv("BOSSMAN_COMMIT", NEW);
    try {
      const a = { version: 1, checkedAt: new Date().toISOString(), deployed: OLD, tip: NEW, commits: [], paths: [], infraPaths: [], runnerChanged: false };
      await ctx.selfDeploy.noteLive(a, null);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await ctx.review.releaseGoLiveWaiters(ctx.co.company.id)).toBe(1);
    expect((await ctx.row(id)).goLiveWait).toBeNull();
    expect(await afterMergeWakes(id)).toHaveLength(1);
  });
});
