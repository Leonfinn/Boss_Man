// BOS-1413: a merge is pinned to the branch head the reviews covered. A commit made while the merge waits is never
// checked or pushed: the queued job is dropped, the ticket goes back to its author, and nothing lands.
// The fake runner behaves like the real one: it answers branch_moved when the branch is not at the pin it was handed.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.hoisted(() => {
  process.env.BOSSMAN_CHECK_JOB_POLL_MS = "20";
  process.env.BOSSMAN_MERGE_RETARGET_MS = "20";
});
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { sharedDatabase } from "./helpers/shared-server.js";
import { checkJobs, reviewRequests, settings, tickets } from "../src/db/schema.js";
import { approveAndWait } from "./helpers.js";

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

const REVIEWED = "b".repeat(40);
const LATE = "c".repeat(40);
const DIFF: WorkspaceDiff = { baseCommit: "a".repeat(40), head: REVIEWED, commits: [{ sha: REVIEWED, subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts", truncated: false };
const prepared = (branchSha: string | undefined, n: number) => ({ status: "prepared", commit: String(n).repeat(40), tree: String(n + 1).repeat(40), targetSha: "1".repeat(40), ...(branchSha ? { branchSha } : {}) });

// oldRunner: no "merge-pin" feature, ignores the pin, names no branch commit. noBranchSha: announces the feature but omits branchSha.
// lateHead: the head every workspace.diff answer reports once the approval has stamped REVIEWED.
async function setup(o: { covers?: boolean | null; oldRunner?: boolean; noBranchSha?: boolean; lateHead?: string } = {}) {
  await shared.reset();
  const { db } = shared;
  const built = await (app ??= buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git", verifyCommand: "pnpm test" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  // The branch tip on the runner, moved by the tests. Prepares and finishes pin to what the server asked for.
  const state = { branch: REVIEWED, merged: null as string | null, pins: [] as Array<string | undefined>, prepares: 0, diffs: 0, ticketId: "" };
  built.runners.connect(reg.runnerId, (c: RunnerCommand) => {
    const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") {
      // Reports REVIEWED until the approval has stamped its head on the review row, LATE after: the approval stamps what it
      // reads, and every later read (the landing, a retry) sees the commit the author made since. No call counting.
      void db.select({ head: reviewRequests.head }).from(reviewRequests).where(eq(reviewRequests.ticketId, state.ticketId)).then((rows) => {
        state.diffs++;
        const head = o.lateHead && rows.some((r) => r.head) ? o.lateHead : REVIEWED;
        reply({ ...DIFF, head, commits: [{ sha: head, subject: "Work" }] });
      });
    }
    if (c.type === "workspace.verify") reply({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 5 });
    if (c.type === "workspace.carried") reply({ carried: [] });
    if (c.type === "workspace.migrations") reply({ needed: false, reason: "Nothing taken." });
    if (c.type === "workspace.covers") {
      if (o.covers === null || o.covers === undefined) reply({}); // can't say
      else reply({ covers: o.covers, reason: o.covers ? "" : "new code", newCommits: o.covers ? 0 : 1, handMerges: 0 });
    }
    if (c.type === "workspace.merge") {
      const x = c as unknown as { phase?: string; tree?: string; commit?: string; pin?: string };
      state.pins.push(x.pin);
      if (!o.oldRunner && x.pin && x.pin !== state.branch) return reply({ status: "branch_moved", head: state.branch, pinned: x.pin }), true;
      if (x.phase === "prepare") {
        state.prepares++;
        reply(prepared(o.oldRunner || o.noBranchSha ? undefined : state.branch, 7));
      } else {
        state.merged = x.commit ?? null;
        reply({ status: "merged", commit: x.commit });
      }
    }
    return true;
  }, o.oldRunner ? ["carried-check", "signoff-covers"] : ["carried-check", "signoff-covers", "merge-pin"]);
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  state.ticketId = t.id;
  await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
  await db.insert(settings).values({ key: "check_queue_mode", value: "server" });
  const jobOf = async () => {
    for (let i = 0; i < 200; i++) {
      const [job] = await db.select().from(checkJobs).where(eq(checkJobs.ticketId, t.id));
      if (job) return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("no job queued");
  };
  const passJob = (id: string) => db.update(checkJobs).set({ state: "passed", exitCode: 0, startedAt: new Date(), endedAt: new Date() }).where(eq(checkJobs.id, id));
  const stateOf = async () => (await db.select({ s: tickets.systemState }).from(tickets).where(eq(tickets.id, t.id)))[0]!.s;
  return { db, req, ticket: t, state, jobOf, passJob, stateOf };
}

describe("a merge is pinned to the reviewed head (BOS-1413)", () => {
  it("merges when the branch stays at the reviewed head, and every step carries the pin", async () => {
    const c = await setup();
    const res = approveAndWait(c.req, c.ticket.id);
    await c.passJob((await c.jobOf()).id);
    expect((await res).json()).toMatchObject({ outcome: "merged" });
    expect(c.state.pins.length).toBeGreaterThanOrEqual(2);
    expect(c.state.pins.every((p) => p === REVIEWED)).toBe(true);
  });

  it("(a) a commit made before the first prepare is not merged: no job, ticket sent back", async () => {
    const c = await setup();
    c.state.branch = LATE;
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "branch_changed" });
    expect(c.state.merged).toBeNull();
    expect(await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).toHaveLength(0);
    expect(await c.stateOf()).toBe("in_progress");
  });

  it("(b) a commit made while the check waits for a slot drops the job and merges nothing", async () => {
    const c = await setup();
    const res = approveAndWait(c.req, c.ticket.id);
    const job = await c.jobOf();
    c.state.branch = LATE; // the next refresh of the queued job sees it
    expect((await res).json()).toMatchObject({ outcome: "branch_changed" });
    const [after] = await c.db.select().from(checkJobs).where(eq(checkJobs.id, job.id));
    expect(["cancelled", "stuck"]).toContain(after!.state);
    expect(c.state.merged).toBeNull();
    expect(await c.stateOf()).toBe("in_progress");
  });

  it("(c) a commit made after the check passed is refused at finish", async () => {
    const c = await setup();
    const res = approveAndWait(c.req, c.ticket.id);
    const job = await c.jobOf();
    // Turn the refresh off, so only finish can notice.
    await c.db.insert(settings).values({ key: "merge_retarget", value: false });
    c.state.branch = LATE;
    await c.passJob(job.id);
    expect((await res).json()).toMatchObject({ outcome: "branch_changed" });
    expect(c.state.merged).toBeNull();
    expect(await c.stateOf()).toBe("in_progress");
  });

  it("(d) a head that only has main merged in is carried: the pin moves and the merge goes ahead", async () => {
    const c = await setup({ covers: true });
    c.state.branch = LATE;
    const res = approveAndWait(c.req, c.ticket.id);
    await c.passJob((await c.jobOf()).id);
    expect((await res).json()).toMatchObject({ outcome: "merged" });
    expect(c.state.pins.at(-1)).toBe(LATE);
    expect(c.state.merged).not.toBeNull();
  });

  it("(e) when the runner can't say what came in, nothing is merged", async () => {
    const c = await setup({ covers: null });
    c.state.branch = LATE;
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "branch_changed" });
    expect(c.state.merged).toBeNull();
  });

  it("(f) a ticket with no owner sign-off (low risk) is pinned too", async () => {
    const c = await setup();
    await c.db.update(tickets).set({ risk: "low" }).where(eq(tickets.id, c.ticket.id));
    c.state.branch = LATE;
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "branch_changed" });
    expect(c.state.merged).toBeNull();
  });

  it("(g) a runner without the merge-pin feature gets no pin and merges as before, with no send-back", async () => {
    const c = await setup({ oldRunner: true });
    const res = approveAndWait(c.req, c.ticket.id);
    await c.passJob((await c.jobOf()).id);
    expect((await res).json()).toMatchObject({ outcome: "merged" });
    expect(c.state.pins.length).toBeGreaterThanOrEqual(2);
    expect(c.state.pins.every((p) => p === undefined)).toBe(true);
    expect(c.state.merged).not.toBeNull();
  });

  it("(g2) a runner that announces merge-pin but doesn't name the branch commit is refused, not trusted", async () => {
    const c = await setup({ noBranchSha: true });
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "branch_changed" });
    expect(c.state.merged).toBeNull();
  });

  it("(h) a medium-risk ticket whose branch moved after the approval is pinned to the approved head, not the head read now", async () => {
    // The approval stamps REVIEWED (first diff); the landing then reads LATE, as a retry after a lock wait or a restart would.
    const c = await setup({ lateHead: LATE });
    await c.db.update(tickets).set({ risk: "medium" }).where(eq(tickets.id, c.ticket.id));
    c.state.branch = LATE;
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "branch_changed" });
    expect(c.state.pins.every((p) => p === REVIEWED)).toBe(true);
    expect(c.state.merged).toBeNull();
    expect(await c.stateOf()).toBe("in_progress");
  });

  it("(h2) the same, but main was only merged in cleanly: the approved head's pin is carried to the new head and it merges", async () => {
    const c = await setup({ covers: true, lateHead: LATE });
    await c.db.update(tickets).set({ risk: "medium" }).where(eq(tickets.id, c.ticket.id));
    c.state.branch = LATE;
    const res = approveAndWait(c.req, c.ticket.id);
    await c.passJob((await c.jobOf()).id);
    expect((await res).json()).toMatchObject({ outcome: "merged" });
    expect(c.state.pins[0]).toBe(REVIEWED);
    expect(c.state.pins.at(-1)).toBe(LATE);
  });
});
