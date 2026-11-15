// Merge train (BOS-1366, DR-059) through the real landing code and the real check queue (PGlite), with a fake runner that models
// git: each prepared commit holds the tickets of its base plus its own, its tree is that set, and finish pushes only when main's
// tip is the expected base (if given) and merging the ticket onto main still gives the checked tree. The test plays the check
// runner too, passing or failing queued jobs by the tickets in their tree.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";

vi.hoisted(() => {
  process.env.BOSSMAN_CHECK_JOB_POLL_MS = "15";
  process.env.BOSSMAN_MERGE_RETARGET_MS = "15";
});
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { sharedDatabase } from "./helpers/shared-server.js";
import { activity, checkJobs, settings, tickets } from "../src/db/schema.js";
import { resetTrains } from "../src/services/merge-train.js";

let shared: Awaited<ReturnType<typeof sharedDatabase>>;
let app: ReturnType<typeof buildApp> | undefined;
beforeAll(async () => {
  shared = await sharedDatabase();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
});
afterAll(async () => {
  await (await app)?.app.close();
  await shared.close();
});

const DIFF: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts", truncated: false };
const hex = (n: number) => n.toString(16).padStart(40, "0");

/** A model of the repo: commits hold a set of tickets; a tree is the sorted set. */
function fakeGit() {
  let n = 1;
  const commits = new Map<string, { base: string | null; has: string[] }>();
  const root = hex(n++);
  commits.set(root, { base: null, has: [] });
  const g = {
    main: root,
    pushes: [] as Array<{ ticket: string; commit: string; parent: string | null }>,
    seen: [] as Array<{ phase: string; ticket: string; base?: string; expectBase?: string }>,
    /** Pairs of tickets whose changes conflict. */
    clashes: [] as Array<[string, string]>,
    treeOf: (has: string[]) => `tree:${[...has].sort().join(",")}`,
    has: (c: string) => commits.get(c)?.has ?? [],
    onMain(c: string): boolean {
      for (let x: string | null = c; x; x = commits.get(x)?.base ?? null) if (x === g.main) return true;
      return false;
    },
    prepare(ticket: string, base?: string) {
      const on = base ?? g.main;
      if (!commits.has(on) || !g.onMain(on)) return { status: "main_moved" };
      if (g.clashes.some(([x, y]) => (x === ticket && g.has(on).includes(y)) || (y === ticket && g.has(on).includes(x)))) return { status: "conflicts", files: ["src/a.ts"] };
      const has = [...new Set([...g.has(on), ticket])];
      const commit = hex(n++);
      commits.set(commit, { base: on, has });
      return { status: "prepared", commit, tree: g.treeOf(has), targetSha: on };
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
    /** Someone lands work outside the train (a hand merge). */
    outside(name: string) {
      const c = hex(n++);
      commits.set(c, { base: g.main, has: [...g.has(g.main), name] });
      g.main = c;
    },
  };
  return g;
}

async function setup(opts: { train?: boolean; features?: string[]; slots?: number } = {}) {
  await shared.reset();
  resetTrains();
  const { db } = shared;
  const built = await (app ??= buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/example/customer-app.git", verifyCommand: "pnpm test" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const git = fakeGit();
  const names = new Map<string, string>(); // ticket id -> A, B, C
  built.runners.connect(reg.runnerId, (c: RunnerCommand) => {
    const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") reply(DIFF);
    if (c.type === "workspace.carried") reply({ carried: [] });
    if (c.type === "workspace.migrations") reply({ needed: false, reason: "Nothing taken." });
    if (c.type === "workspace.merge") {
      const x = c as unknown as { ticketId: string; phase?: string; tree?: string; commit?: string; base?: string; expectBase?: string };
      const who = names.get(x.ticketId)!;
      git.seen.push({ phase: x.phase ?? "", ticket: who, ...(x.base ? { base: x.base } : {}), ...(x.expectBase ? { expectBase: x.expectBase } : {}) });
      reply(x.phase === "prepare" ? git.prepare(who, x.base) : git.finish(who, x.commit!, x.tree!, x.expectBase));
    }
    return true;
  }, opts.features ?? ["carried-check", "check-jobs", "merge-base"]);
  await db.insert(settings).values({ key: "check_queue_mode", value: "server" });
  await db.insert(settings).values({ key: "check_slots", value: opts.slots ?? 3 });
  if (opts.train !== false) await db.insert(settings).values({ key: "merge_train", value: true });
  const ticket = async (name: string) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Ticket ${name}`, assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
    names.set(t.id, name);
    return t.id;
  };
  const waitFor = async (what: () => Promise<boolean> | boolean, ms = 8000) => {
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
    }, 15000);
    return out;
  };
  /** Plays the check runner: queued jobs pass, except while `fails(tickets in tree, ticket name, run number)` says so. */
  let stop = false;
  const runs = new Map<string, number>();
  const runJobs = (fails: (has: string[], who: string, run: number) => boolean) => {
    void (async () => {
      while (!stop) {
        // Running too: a dispatcher pump (after a cancel, BOS-1504) may have sent a job to the fake runner, which ignores it.
        const queued = await db.select().from(checkJobs).where(and(inArray(checkJobs.state, ["queued", "running"]), eq(checkJobs.kind, "merge"))).orderBy(asc(checkJobs.queuedAt));
        for (const j of queued) {
          const who = names.get(j.ticketId!)!;
          const run = (runs.get(who) ?? 0) + 1;
          runs.set(who, run);
          const has = j.tree.replace(/^tree:/, "").split(",");
          const bad = fails(has, who, run);
          await db.update(checkJobs).set({ state: bad ? "failed" : "passed", exitCode: bad ? 1 : 0, logTail: bad ? "1 test failed" : "ok", startedAt: new Date(), endedAt: new Date() }).where(and(eq(checkJobs.id, j.id), inArray(checkJobs.state, ["queued", "running"])));
        }
        await new Promise((r) => setTimeout(r, 30));
      }
    })();
    return () => {
      stop = true;
    };
  };
  const events = async (id: string, event: string) => (await db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "merge_line")))).map((r) => r.detail as Record<string, unknown>).filter((d) => d.event === event);
  return { db, git, ticket, approve, outcome, waitFor, runJobs, runs, names, events };
}

/** Approve in this order, each one once the one before has prepared, so the train's order is the approval order. */
async function approveInOrder(c: Awaited<ReturnType<typeof setup>>, ids: string[]) {
  for (const id of ids) {
    const who = c.names.get(id)!;
    await c.approve(id);
    expect(await c.waitFor(() => c.git.seen.some((s) => s.phase === "prepare" && s.ticket === who))).toBe(true);
  }
}

describe("merge train landings (BOS-1366)", () => {
  it("checks each ticket on main plus the ones ahead and lands them in order, each push a fast-forward to the checked commit", async () => {
    const c = await setup();
    const [a, b, d] = [await c.ticket("A"), await c.ticket("B"), await c.ticket("C")];
    await approveInOrder(c, [a, b, d]);
    // Every member is prepared before any check runs: B on A, C on B.
    expect(await c.waitFor(async () => (await c.db.select().from(checkJobs)).length === 3)).toBe(true);
    const trees = (await c.db.select().from(checkJobs).orderBy(asc(checkJobs.queuedAt))).map((j) => j.tree);
    expect(trees).toEqual(["tree:A", "tree:A,B", "tree:A,B,C"]);
    const stop = c.runJobs(() => false);
    expect([await c.outcome(a), await c.outcome(b), await c.outcome(d)]).toEqual(["merged", "merged", "merged"]);
    stop();
    expect(c.git.pushes.map((p) => p.ticket)).toEqual(["A", "B", "C"]);
    // Each push is the prepared commit itself on top of the one before: main only ever gets a checked tree.
    for (let i = 1; i < c.git.pushes.length; i++) expect(c.git.pushes[i]!.parent).toBe(c.git.pushes[i - 1]!.commit);
    expect(c.git.has(c.git.main).sort()).toEqual(["A", "B", "C"]);
    // One check each: a landing ahead spoiled nothing behind it.
    expect([...c.runs.values()]).toEqual([1, 1, 1]);
    expect(c.git.seen.filter((s) => s.phase === "finish").every((s) => !!s.expectBase)).toBe(true);
  });

  it("a real failure in the middle: B is sent back after one re-run, C restacks onto A and lands", async () => {
    const c = await setup();
    const [a, b, d] = [await c.ticket("A"), await c.ticket("B"), await c.ticket("C")];
    await approveInOrder(c, [a, b, d]);
    // B's own check always fails; C's check fails while B is in its tree (B broke it), passes without B.
    const stop = c.runJobs((has, who) => who === "B" || (who === "C" && has.includes("B")));
    expect(await c.outcome(b)).toBe("verify_failed");
    expect([await c.outcome(a), await c.outcome(d)]).toEqual(["merged", "merged"]);
    stop();
    expect(c.git.pushes.map((p) => p.ticket)).toEqual(["A", "C"]);
    expect(c.git.has(c.git.main).sort()).toEqual(["A", "C"]);
    expect(c.runs.get("B")).toBe(2); // the one re-run
    expect(await c.events(b, "rerun")).toEqual([expect.objectContaining({ passed: false })]);
    // C was never sent back for B's failure.
    expect((await c.events(d, "restacked")).length).toBeGreaterThan(0);
    const [cRow] = await c.db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, d));
    expect(cRow!.state).toBe("done");
  });

  it("a flaky failure costs one re-run of that ticket and no restart behind it, and is recorded", async () => {
    const c = await setup();
    const [a, b] = [await c.ticket("A"), await c.ticket("B")];
    await approveInOrder(c, [a, b]);
    const stop = c.runJobs((_has, who, run) => who === "A" && run === 1);
    expect([await c.outcome(a), await c.outcome(b)]).toEqual(["merged", "merged"]);
    stop();
    expect(c.runs.get("A")).toBe(2);
    expect(c.runs.get("B")).toBe(1);
    expect(await c.events(a, "rerun")).toEqual([expect.objectContaining({ passed: true })]);
    expect(await c.events(b, "restacked")).toEqual([]);
    // The flaky pass is visible on the ticket, not just in the numbers.
    const lines = (await c.db.select({ summary: activity.summary }).from(activity).where(eq(activity.ticketId, a))).map((r) => r.summary);
    expect(lines.some((s) => /flaky failure/.test(s ?? ""))).toBe(true);
  });

  it("a clash with a ticket ahead doesn't send the one behind back: it waits to land on main alone, which is the real answer", async () => {
    const c = await setup();
    c.git.clashes.push(["A", "B"]);
    const [a, b] = [await c.ticket("A"), await c.ticket("B")];
    await c.approve(a);
    expect(await c.waitFor(() => c.git.seen.some((s) => s.phase === "prepare" && s.ticket === "A"))).toBe(true);
    await c.approve(b);
    // A's check fails for real, so A never lands; B, clean on main alone, lands.
    const stop = c.runJobs((_has, who) => who === "A");
    expect(await c.outcome(a)).toBe("verify_failed");
    expect(await c.outcome(b)).toBe("merged");
    stop();
    expect(c.git.pushes.map((p) => p.ticket)).toEqual(["B"]);
    // B's first try was stacked on A; the one that landed was on main.
    const bPrepares = c.git.seen.filter((s) => s.phase === "prepare" && s.ticket === "B");
    expect(bPrepares[0]!.base).toBeDefined();
    expect(bPrepares.at(-1)!.base).toBeUndefined();
  });

  it("a member moved out of review gives up its seat at once: its check is cancelled and the ones behind restack and land (BOS-1504)", async () => {
    const c = await setup();
    const [a, b, d] = [await c.ticket("A"), await c.ticket("B"), await c.ticket("C")];
    await approveInOrder(c, [a, b, d]);
    expect(await c.waitFor(async () => (await c.db.select().from(checkJobs)).length === 3)).toBe(true);
    // Sent back by hand while its check waits: no check result will ever come for it.
    await c.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, a));
    expect(await c.waitFor(async () => (await c.db.select({ s: checkJobs.state }).from(checkJobs).where(eq(checkJobs.ticketId, a)))[0]?.s === "cancelled"), "A's job cancelled").toBe(true);
    const stop = c.runJobs(() => false);
    expect(await c.outcome(a), "A's outcome").toBe("check_stuck");
    expect([await c.outcome(b), await c.outcome(d)]).toEqual(["merged", "merged"]);
    stop();
    expect(c.git.pushes.map((p) => p.ticket)).toEqual(["B", "C"]);
    expect(c.git.has(c.git.main).sort()).toEqual(["B", "C"]);
    expect(c.runs.get("A")).toBeUndefined();
    expect((await c.events(b, "restacked")).length).toBeGreaterThan(0);
    expect(await c.events(a, "check_ended")).toEqual([expect.objectContaining({ why: "the ticket left review" })]);
  }, 60_000);

  it("main moving outside the train: the head prepares again on the new main and everyone behind restacks, then all land", async () => {
    const c = await setup();
    const [a, b] = [await c.ticket("A"), await c.ticket("B")];
    await approveInOrder(c, [a, b]);
    expect(await c.waitFor(async () => (await c.db.select().from(checkJobs)).length === 2)).toBe(true);
    c.git.outside("X");
    const stop = c.runJobs(() => false);
    expect([await c.outcome(a), await c.outcome(b)]).toEqual(["merged", "merged"]);
    stop();
    expect(c.git.has(c.git.main).sort()).toEqual(["A", "B", "X"]);
    expect(c.git.pushes.map((p) => p.ticket)).toEqual(["A", "B"]);
  });

  it("turning the switch off mid-train: members already in it still land on their exact base, a new arrival takes today's path", async () => {
    const c = await setup();
    const [a, b, d] = [await c.ticket("A"), await c.ticket("B"), await c.ticket("C")];
    await approveInOrder(c, [a, b]);
    expect(await c.waitFor(async () => (await c.db.select().from(checkJobs)).length === 2)).toBe(true);
    await c.db.update(settings).set({ value: false }).where(eq(settings.key, "merge_train"));
    await c.approve(d);
    expect(await c.waitFor(() => c.git.seen.some((s) => s.phase === "prepare" && s.ticket === "C"))).toBe(true);
    const stop = c.runJobs(() => false);
    expect([await c.outcome(a), await c.outcome(b), await c.outcome(d)]).toEqual(["merged", "merged", "merged"]);
    stop();
    const finishes = c.git.seen.filter((s) => s.phase === "finish");
    expect(finishes.filter((s) => s.ticket !== "C").every((s) => !!s.expectBase)).toBe(true);
    expect(c.git.seen.filter((s) => s.ticket === "C").some((s) => s.base || s.expectBase)).toBe(false);
    expect(c.git.has(c.git.main).sort()).toEqual(["A", "B", "C"]);
  });

  it("with the switch off, or a runner without merge-base, merges as before: no base or expectBase is ever sent", async () => {
    for (const opts of [{ train: false }, { features: ["carried-check", "check-jobs"] }]) {
      const c = await setup(opts);
      const a = await c.ticket("A");
      await c.approve(a);
      const stop = c.runJobs(() => false);
      expect(await c.outcome(a)).toBe("merged");
      stop();
      expect(c.git.seen.some((s) => s.base || s.expectBase)).toBe(false);
      expect(await c.events(a, "restacked")).toEqual([]);
    }
  });
});
