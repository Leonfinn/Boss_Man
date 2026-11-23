// BOS-2360: the merge train with "Wait for GitHub CI" on. Each seated member pushes its own stacked merge commit for GitHub CI
// beside its own check, and a GitHub pass on a member behind covers the members ahead of it (its tree holds their changes).
// Through the real landing code and check queue (PGlite), with a fake runner that models git as merge-train-landing.test.ts
// does (a commit holds a set of tickets; finish pushes only on the expected base) and a fake GitHub whose runs pass or fail
// by the tickets in the pushed commit.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";

vi.hoisted(() => {
  process.env.BOSSMAN_CHECK_JOB_POLL_MS = "15";
  process.env.BOSSMAN_MERGE_RETARGET_MS = "15";
  process.env.BOSSMAN_TRAIN_TRIAL_MIN_MS = "15";
});
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, checkJobs, checkResults, settings, tickets } from "../src/db/schema.js";
import { resetTrains } from "../src/services/merge-train.js";

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx | undefined;
afterEach(async () => {
  ctx?.stopJobs();
  await new Promise((r) => setTimeout(r, 50));
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const DIFF: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts", truncated: false };
const hex = (n: number) => n.toString(16).padStart(40, "0");
const FLAKY_TEST = "apps/server/test/flaky.test.ts";

/** A model of the repo: commits hold a set of tickets; a tree is the sorted set (as in merge-train-landing.test.ts). */
function fakeGit() {
  let n = 1;
  const commits = new Map<string, { base: string | null; has: string[] }>();
  const root = hex(n++);
  commits.set(root, { base: null, has: [] });
  const g = {
    main: root,
    pushes: [] as Array<{ ticket: string; commit: string; parent: string | null }>,
    seen: [] as Array<{ phase: string; ticket: string; base?: string; expectBase?: string }>,
    treeOf: (has: string[]) => `tree:${[...has].sort().join(",")}`,
    has: (c: string) => commits.get(c)?.has ?? [],
    onMain(c: string): boolean {
      for (let x: string | null = c; x; x = commits.get(x)?.base ?? null) if (x === g.main) return true;
      return false;
    },
    prepare(ticket: string, base?: string) {
      const on = base ?? g.main;
      if (!commits.has(on) || !g.onMain(on)) return { status: "main_moved" };
      const has = [...new Set([...g.has(on), ticket])];
      const commit = hex(n++);
      commits.set(commit, { base: on, has });
      return { status: "prepared", commit, tree: g.treeOf(has), targetSha: on, branchSha: DIFF.head };
    },
    finish(ticket: string, commit: string, tree: string, expectBase?: string) {
      if (expectBase && g.main !== expectBase) return { status: "main_moved" };
      const has = [...new Set([...g.has(g.main), ticket])];
      if (g.treeOf(has) !== tree) return { status: "main_moved" };
      const same = commits.get(commit)?.base === g.main;
      const pushed = same ? commit : hex(n++);
      if (!same) commits.set(pushed, { base: g.main, has });
      g.pushes.push({ ticket, commit: pushed, parent: g.main });
      g.main = pushed;
      return { status: "merged", commit: pushed };
    },
  };
  return g;
}

type RunState = "running" | "passed" | "failed";

/**
 * A fake GitHub. Every pushed commit gets one workflow run; `ci(has, who, nth)` says how it looks on the nth read (has: the
 * tickets in the commit, who: the ticket that pushed it). After "re-run failed jobs", `retried` says how the retry ends.
 * `named`: a failure's annotation names FLAKY_TEST (the token has Checks), so the gate's flake handling (BOS-1733) applies.
 */
function fakeGitHub(git: ReturnType<typeof fakeGit>) {
  const pushed = new Map<string, { who: string; id: number }>();
  const reads = new Map<string, number>();
  const state = {
    ci: (_has: string[], _who: string, _nth: number): RunState => "passed",
    retried: (_has: string[], _who: string): RunState => "passed",
    named: false,
    retriedRuns: new Set<number>(),
    failedReruns: [] as string[],
    cancels: [] as string[],
    /** Every read result, in order: who pushed the commit and what it showed. */
    seen: [] as Array<{ who: string; state: RunState }>,
  };
  let nextId = 100;
  const runOf = (id: number) => [...pushed.entries()].find(([, p]) => p.id === id);
  const stateOf = (sha: string): RunState => {
    const p = pushed.get(sha)!;
    const has = git.has(sha);
    if (state.retriedRuns.has(p.id)) return state.retried(has, p.who);
    const nth = (reads.get(sha) ?? 0) + 1;
    reads.set(sha, nth);
    return state.ci(has, p.who, nth);
  };
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const cancel = /\/actions\/runs\/(\d+)\/cancel$/.exec(url);
    if (cancel) {
      state.cancels.push(runOf(Number(cancel[1]))?.[1].who ?? "?");
      return json(202, {});
    }
    const rerun = /\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(url);
    if (rerun && init?.method === "POST") {
      state.failedReruns.push(runOf(Number(rerun[1]))?.[1].who ?? "?");
      state.retriedRuns.add(Number(rerun[1]));
      return json(201, {});
    }
    const runs = /\/actions\/runs\?head_sha=([0-9a-f]+)/.exec(url);
    if (runs) {
      const sha = runs[1]!;
      const p = pushed.get(sha);
      if (!p) return json(200, { total_count: 0, workflow_runs: [] });
      const s = stateOf(sha);
      state.seen.push({ who: p.who, state: s });
      const run = { id: p.id, name: "CI", workflow_id: 7, event: "push", head_sha: sha, created_at: "2026-11-23T10:00:00Z", html_url: `https://github.com/example/customer-app/actions/runs/${p.id}`, status: s === "running" ? "in_progress" : "completed", conclusion: s === "running" ? null : s === "passed" ? "success" : "failure" };
      return json(200, { total_count: 1, workflow_runs: [run] });
    }
    const jobs = /\/actions\/runs\/(\d+)\/jobs/.exec(url);
    if (jobs) {
      const id = Number(jobs[1]);
      return json(200, { jobs: [{ id: id * 10, name: "check", status: "completed", conclusion: "failure", html_url: "", runner_name: "GitHub Actions 1", steps: [{ number: 1, name: "Run tests", status: "completed", conclusion: "failure" }] }] });
    }
    if (/\/check-runs\/\d+\/annotations/.test(url)) return state.named ? json(200, [{ path: FLAKY_TEST, annotation_level: "failure", message: "1 test failed", start_line: 1, end_line: 1 }]) : json(403, { message: "Resource not accessible by personal access token" });
    if (/\/actions\/jobs\/\d+\/logs/.test(url)) return json(404, { message: "Not Found" });
    if (/\/actions\/workflows\/\d+\/runs/.test(url)) return json(200, { total_count: 0, workflow_runs: [] });
    if (/\/actions\/runs\?branch=/.test(url)) return json(200, { total_count: 0, workflow_runs: [] });
    return json(404, { message: `no fake for ${url}` });
  }) as typeof globalThis.fetch;
  const publish = (sha: string, who: string) => {
    if (!pushed.has(sha)) pushed.set(sha, { who, id: nextId++ });
  };
  return { fetch, state, publish, pushed };
}

async function setup(opts: { slots?: number } = {}) {
  resetTrains();
  const git = fakeGit();
  const gh = fakeGitHub(git);
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch: gh.fetch, ciTiming: { pollMs: 10, graceMs: 2_000, ceilingMs: 20_000, retryMs: 5 } });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/example/customer-app.git", verifyCommand: "pnpm test" });
  const { secret } = (await req("POST", "/api/secrets", { name: "GitHub", kind: "generic", value: "made-up-token-value" })).json();
  await req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "GIT_TOKEN" });
  const { secret: ciSecret } = (await req("POST", "/api/secrets", { name: "GitHub CI", kind: "generic", value: "made-up-ci-token-value" })).json();
  await req("POST", `/api/secrets/${ciSecret.id}/grants`, { companyId: company.id, envName: "GIT_CI_TOKEN" });
  expect((await req("PUT", "/api/settings/wait-for-ci", { on: true })).json()).toEqual({ on: true });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const names = new Map<string, string>(); // ticket id -> A, B, C
  built.runners.connect(
    reg.runnerId,
    (c: RunnerCommand) => {
      const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
      if (c.type === "workspace.diff") reply(DIFF);
      if (c.type === "workspace.carried") reply({ carried: [] });
      if (c.type === "workspace.migrations") reply({ needed: false, reason: "Nothing taken." });
      if (c.type === "workspace.merge") {
        const x = c as unknown as { ticketId: string; phase?: string; tree?: string; commit?: string; base?: string; expectBase?: string };
        const who = names.get(x.ticketId)!;
        git.seen.push({ phase: x.phase ?? "", ticket: who, ...(x.base ? { base: x.base } : {}), ...(x.expectBase ? { expectBase: x.expectBase } : {}) });
        if (x.phase === "publish") {
          gh.publish(x.commit!, who);
          reply({ status: "published", branch: `bossman-ci/${x.ticketId}`, commit: x.commit, hasWorkflows: true });
        } else if (x.phase === "unpublish") reply({ status: "unpublished", branch: `bossman-ci/${x.ticketId}` });
        else reply(x.phase === "prepare" ? git.prepare(who, x.base) : git.finish(who, x.commit!, x.tree!, x.expectBase));
      }
      return true;
    },
    ["carried-check", "check-jobs", "merge-base", "merge-pin", "ci-publish"],
  );
  await db.insert(settings).values({ key: "check_queue_mode", value: "server" });
  await db.insert(settings).values({ key: "check_slots", value: opts.slots ?? 3 });
  await db.insert(settings).values({ key: "merge_train", value: true });
  const ticket = async (name: string) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Ticket ${name}`, assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
    names.set(t.id, name);
    return t.id;
  };
  const waitFor = async (what: () => Promise<boolean> | boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await what()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  };
  const approve = async (id: string) => {
    const res = await req("POST", `/api/tickets/${id}/review`, { verdict: "approved" });
    expect(res.statusCode).toBe(202);
  };
  const outcome = async (id: string) => {
    let out: string | undefined;
    await waitFor(async () => {
      const { landing } = (await req("GET", `/api/tickets/${id}/landing`)).json() as { landing?: { state: string; outcome: string } };
      if (landing?.state === "finished") out = landing.outcome;
      return !!out;
    }, 20_000);
    return out;
  };
  /** Plays the check runner: every queued merge job (the gate's own check, and its re-run of GitHub's failed tests) passes. */
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const queued = await db.select().from(checkJobs).where(and(inArray(checkJobs.state, ["queued", "running"]), eq(checkJobs.kind, "merge"))).orderBy(asc(checkJobs.queuedAt)).catch(() => []);
      for (const j of queued) await db.update(checkJobs).set({ state: "passed", exitCode: 0, logTail: "ok", startedAt: new Date(), endedAt: new Date() }).where(and(eq(checkJobs.id, j.id), inArray(checkJobs.state, ["queued", "running"]))).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  const events = async (id: string, event: string) => (await db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "merge_line")))).map((r) => r.detail as Record<string, unknown>).filter((d) => d.event === event);
  const allEvents = async (event: string) => (await db.select({ detail: activity.detail }).from(activity).where(eq(activity.kind, "merge_line"))).map((r) => r.detail as Record<string, unknown>).filter((d) => d.event === event);
  const summaries = async (id: string) => (await db.select({ summary: activity.summary }).from(activity).where(eq(activity.ticketId, id))).map((r) => r.summary ?? "");
  const stateOf = async (id: string) => (await db.select({ s: tickets.systemState }).from(tickets).where(eq(tickets.id, id)))[0]?.s;
  const out = { app: built.app, close, stopJobs: () => void (stopped = true), db, git, gh, ticket, approve, outcome, waitFor, names, events, allEvents, summaries, stateOf, companyId: company.id, serverStatus: built.serverStatus };
  ctx = out;
  return out;
}

/** Approve in this order, each once the one before has prepared, so the train's order is the approval order. */
async function approveInOrder(c: Ctx, ids: string[]) {
  for (const id of ids) {
    const who = c.names.get(id)!;
    await c.approve(id);
    expect(await c.waitFor(() => c.git.seen.some((s) => s.phase === "prepare" && s.ticket === who))).toBe(true);
  }
}

describe("merge train with GitHub CI gating (BOS-2360)", () => {
  it("three approved tickets land in order on one overlapping set of GitHub runs: no rebuild, no landing turn", async () => {
    const c = await setup();
    const [a, b, d] = [await c.ticket("A"), await c.ticket("B"), await c.ticket("C")];
    await approveInOrder(c, [a, b, d]);
    expect([await c.outcome(a), await c.outcome(b), await c.outcome(d)]).toEqual(["merged", "merged", "merged"]);
    expect(c.git.pushes.map((p) => p.ticket)).toEqual(["A", "B", "C"]);
    // Each push is the stacked commit itself, a fast-forward on the one before, on exactly the base it was prepared on.
    for (let i = 1; i < c.git.pushes.length; i++) expect(c.git.pushes[i]!.parent).toBe(c.git.pushes[i - 1]!.commit);
    expect(c.git.seen.filter((s) => s.phase === "finish").every((s) => !!s.expectBase)).toBe(true);
    // One GitHub run per ticket, each on its stacked commit (C's holds A and B too).
    expect([...c.gh.pushed.values()].map((p) => p.who)).toEqual(["A", "B", "C"]);
    expect([...c.gh.pushed.keys()].map((sha) => c.git.has(sha).sort().join(""))).toEqual(["A", "AB", "ABC"]);
    // The one-at-a-time path's rebuild chase and landing turn never happen.
    expect(await c.allEvents("rebuilt")).toEqual([]);
    expect(await c.allEvents("landing_turn")).toEqual([]);
    expect(await c.allEvents("restacked")).toEqual([]);
    // server_status says the switch is on, so nobody has to infer it from the records.
    expect(((await c.serverStatus.status(c.companyId)) as { mergeTrainOn: unknown }).mergeTrainOn).toBe(true);
  }, 60_000);

  it("a pass on the tail covers the tickets ahead: they land without waiting for their own runs, which are cancelled", async () => {
    const c = await setup();
    // A's and B's own runs never finish; C's (which holds A and B) passes.
    c.gh.state.ci = (_has, who) => (who === "C" ? "passed" : "running");
    const [a, b, d] = [await c.ticket("A"), await c.ticket("B"), await c.ticket("C")];
    await approveInOrder(c, [a, b, d]);
    expect([await c.outcome(a), await c.outcome(b), await c.outcome(d)]).toEqual(["merged", "merged", "merged"]);
    expect(c.git.pushes.map((p) => p.ticket)).toEqual(["A", "B", "C"]);
    const cCommit = [...c.gh.pushed.entries()].find(([, p]) => p.who === "C")![0];
    for (const id of [a, b]) {
      expect(await c.events(id, "ci_covered")).toEqual([expect.objectContaining({ by: d, commit: cCommit })]);
      // The pass row names the covering commit, so nothing reads it as a run of its own.
      const rows = await c.db.select({ detail: checkResults.detail }).from(checkResults).where(and(eq(checkResults.ticketId, id), eq(checkResults.kind, "ci")));
      expect(rows).toEqual([{ detail: `covered by ${cCommit}` }]);
      expect((await c.summaries(id)).some((s) => /is covered by .*GitHub run/.test(s) && /cancelled its GitHub run/.test(s))).toBe(true);
    }
    expect(c.gh.state.cancels.sort()).toEqual(["A", "B"]);
    expect(await c.events(d, "ci_covered")).toEqual([]);
  }, 60_000);

  it("a real failure in the middle: B goes back with GitHub's failure, A lands, C restacks onto A without charge and lands", async () => {
    const c = await setup();
    // B breaks GitHub CI: any commit holding B fails. A's run passes. Nothing finishes until C's stacked commit is pushed,
    // so all three are in the train together.
    const cIn = () => [...c.gh.pushed.values()].some((p) => p.who === "C");
    c.gh.state.ci = (has) => (!cIn() ? "running" : has.includes("B") ? "failed" : "passed");
    const [a, b, d] = [await c.ticket("A"), await c.ticket("B"), await c.ticket("C")];
    await approveInOrder(c, [a, b, d]);
    expect(await c.outcome(b)).toBe("verify_failed");
    expect([await c.outcome(a), await c.outcome(d)]).toEqual(["merged", "merged"]);
    expect(c.git.pushes.map((p) => p.ticket)).toEqual(["A", "C"]);
    expect(c.git.has(c.git.main).sort()).toEqual(["A", "C"]);
    expect(await c.stateOf(b)).toBe("in_progress");
    expect(await c.stateOf(d)).toBe("done");
    // C was not sent back for B's failure: it restacked and its new run (without B) passed.
    expect((await c.events(d, "restacked")).length).toBeGreaterThan(0);
    const bBack = await c.db.select({ passed: checkResults.passed }).from(checkResults).where(and(eq(checkResults.ticketId, d), eq(checkResults.kind, "ci"), eq(checkResults.passed, false)));
    expect(bBack).toEqual([]);
    // B went back on GitHub's failure (today's ciVerdict), once.
    const bFailed = await c.db.select({ passed: checkResults.passed }).from(checkResults).where(and(eq(checkResults.ticketId, b), eq(checkResults.kind, "ci")));
    expect(bFailed).toEqual([{ passed: false }]);
    expect((await c.events(b, "left")).length).toBe(1);
  }, 60_000);

  it("the head's run fails once while the tail's passes: the head is covered and lands, nobody is sent back", async () => {
    const c = await setup();
    let bPassed = false;
    c.gh.state.ci = (_has, who) => {
      if (who === "B") return (bPassed = true), "passed";
      return bPassed ? "failed" : "running";
    };
    const [a, b] = [await c.ticket("A"), await c.ticket("B")];
    await approveInOrder(c, [a, b]);
    expect([await c.outcome(a), await c.outcome(b)]).toEqual(["merged", "merged"]);
    expect(c.git.pushes.map((p) => p.ticket)).toEqual(["A", "B"]);
    expect(await c.events(a, "ci_covered")).toEqual([expect.objectContaining({ by: b })]);
    expect(await c.allEvents("attempt_failed")).toEqual([]);
  }, 60_000);

  it("a GitHub flake on a stacked run is retried (BOS-2345), not blamed on any ticket, and reported to the CEO", async () => {
    const c = await setup();
    c.gh.state.named = true;
    // A's first run fails in a test file the branch doesn't change; the retry passes. B's run waits until A's retry was asked
    // for, so no pass behind A covers it first.
    c.gh.state.ci = (_has, who) => (who === "A" ? "failed" : c.gh.state.failedReruns.length ? "passed" : "running");
    const [a, b] = [await c.ticket("A"), await c.ticket("B")];
    await approveInOrder(c, [a, b]);
    expect([await c.outcome(a), await c.outcome(b)]).toEqual(["merged", "merged"]);
    expect(c.gh.state.failedReruns).toEqual(["A"]);
    expect(await c.allEvents("attempt_failed")).toEqual([]);
    const flaky = await c.db.select({ title: tickets.title }).from(tickets).where(eq(tickets.title, `Flaky on GitHub: ${FLAKY_TEST}`));
    expect(flaky.length).toBe(1);
  }, 60_000);

  it("the tail fails while the head is still running: it waits; when the head fails for real, the tail restacks without it and lands", async () => {
    const c = await setup();
    let bFailedSeen = false;
    c.gh.state.ci = (has, who) => {
      if (who === "B") {
        if (has.includes("A")) return (bFailedSeen = true), "failed";
        return "passed";
      }
      return bFailedSeen ? "failed" : "running";
    };
    const [a, b] = [await c.ticket("A"), await c.ticket("B")];
    await approveInOrder(c, [a, b]);
    expect(await c.outcome(a)).toBe("verify_failed");
    expect(await c.outcome(b)).toBe("merged");
    expect(c.git.pushes.map((p) => p.ticket)).toEqual(["B"]);
    expect(await c.stateOf(b)).toBe("done");
    expect((await c.events(b, "restacked")).length).toBeGreaterThan(0);
  }, 60_000);
});
