// BOS-1833: a hold set while a merge check waits for a slot stops that check. On 18 Nov three merges (BOS-1774, BOS-1669,
// BOS-1670) started checks under a merge-check fix hold because refuseIfHeld ran only when the attempt began.
// A fake runner prepares one tree and merges it on finish; the test plays the check queue by hand.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.hoisted(() => {
  process.env.BOSSMAN_CHECK_JOB_POLL_MS = "200";
});
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { sharedDatabase } from "./helpers/shared-server.js";
import { activity, checkJobs, reviewRequests, settings, tickets } from "../src/db/schema.js";
import { createHold } from "../src/services/review-holds.js";

let shared: Awaited<ReturnType<typeof sharedDatabase>>;
let app: ReturnType<typeof buildApp> | undefined;
beforeAll(async () => {
  shared = await sharedDatabase();
});
afterEach(async () => {
  // test-lines-ok: lets the last background write settle before the database closes; nothing to poll for
  await new Promise((resolve) => setTimeout(resolve, 50));
});
afterAll(async () => {
  await (await app)?.app.close();
  await shared.close();
});

const DIFF: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts", truncated: false };
const PREP = { status: "prepared", commit: "f".repeat(40), tree: "9".repeat(40), targetSha: "1".repeat(40), branchSha: "b".repeat(40) };

async function setup() {
  await shared.reset();
  const { db } = shared;
  const built = await (app ??= buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const ceo = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Chief" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git", verifyCommand: "pnpm test" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const state = { finishes: 0 };
  built.runners.connect(reg.runnerId, (c: RunnerCommand) => {
    const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") reply(DIFF);
    if (c.type === "workspace.carried") reply({ carried: [] });
    if (c.type === "workspace.migrations") reply({ needed: false, reason: "Nothing taken." });
    if (c.type === "workspace.merge") {
      const x = c as unknown as { phase?: string; commit?: string };
      if (x.phase === "prepare") reply(PREP);
      else {
        state.finishes++;
        reply({ status: "merged", commit: x.commit });
      }
    }
    return true;
  }, ["carried-check"]);
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
  await db.insert(settings).values({ key: "check_queue_mode", value: "server" });
  await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: ceo.id, round: 1, seq: 0, status: "approved" });
  const waitFor = async (what: () => Promise<boolean>, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await what()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };
  const jobs = () => db.select().from(checkJobs).where(eq(checkJobs.ticketId, t.id));
  const landing = async () => ((await req("GET", `/api/tickets/${t.id}/landing`)).json() as { landing: { state: string; outcome?: string; text?: string } | null }).landing;
  const lineRows = async (event: string) =>
    (await db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "merge_line")))).map((r) => r.detail as Record<string, unknown>).filter((d) => d.event === event);
  return { db, req, ticket: t, state, waitFor, jobs, landing, lineRows, ceo };
}

describe("a hold set while the merge check waits for a slot (BOS-1833)", () => {
  it("the queued check is cancelled, the landing ends held, and nothing merges", async () => {
    const c = await setup();
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).statusCode).toBe(202);
    expect(await c.waitFor(async () => (await c.jobs()).length === 1)).toBe(true);
    const [job] = await c.jobs();
    expect(job).toMatchObject({ state: "queued" });
    // The hold arrives after the attempt began, as the 18 Nov fix hold did.
    await createHold(c.db, { ticketId: c.ticket.id, reviewRequestId: null, reviewerAgentId: null, reason: "Waiting for a fix to merge", releaseAt: null, waits: [] });
    expect(await c.waitFor(async () => (await c.landing())?.state === "finished")).toBe(true);
    expect(await c.landing()).toMatchObject({ state: "finished", outcome: "held" });
    expect((await c.jobs()).find((j) => j.id === job!.id)).toMatchObject({ state: "cancelled" });
    expect(await c.lineRows("check_ended")).toEqual([expect.objectContaining({ why: "the merge was held while the check waited" })]);
    expect(c.state.finishes).toBe(0);
  });
});
