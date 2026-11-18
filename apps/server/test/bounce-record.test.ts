// BOS-1723: a merge-check bounce leaves a record in the ticket's conversation with the job id and the failing lines, so the
// failure can be read from the ticket after the wake note that carried the bounce is gone. Real landings, fake runner.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.hoisted(() => { process.env.BOSSMAN_CHECK_JOB_POLL_MS = "20"; });
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { sharedDatabase } from "./helpers/shared-server.js";
import { checkJobs, settings, ticketMessages, tickets, wakes } from "../src/db/schema.js";
import { checkQueue } from "../src/services/check-queue.js";
import { BOUNCE_RECORD_MAX, ciBounceRecord, gateBounceRecord } from "../src/services/review.js";
import { conversationLines } from "../src/services/ticket-chat.js";
import { approveAndWait } from "./helpers.js";

let shared: Awaited<ReturnType<typeof sharedDatabase>>;
let app: ReturnType<typeof buildApp> | undefined;
beforeAll(async () => {
  shared = await sharedDatabase();
});
afterEach(async () => {
  // test-lines-ok: lets background landing work settle before the next reset; no event to wait on (added by BOS-1723, before the ratchet)
  await new Promise((resolve) => setTimeout(resolve, 50));
});
afterAll(async () => {
  await (await app)?.app.close();
  await shared.close();
});

const DIFF: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Add rate limiting" }], files: [{ path: "src/limit.ts", added: 1, removed: 0 }], diff: "diff --git a/src/limit.ts b/src/limit.ts", truncated: false };
const FAIL = { ok: false, exitCode: 1, timedOut: false, output: "lint ok\n FAIL  src/limit.test.ts > limits > counts\nAssertionError: expected 1 to be 2\n", ms: 5 };
const PREPARED = { status: "prepared", commit: "f".repeat(40), tree: "9".repeat(40), targetSha: "1".repeat(40), branchSha: "b".repeat(40) };

async function setup(verify: unknown) {
  await shared.reset();
  const { db } = shared;
  const built = await (app ??= buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/example/customer-app.git", verifyCommand: "pnpm test" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, (c: RunnerCommand) => {
    const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") reply(DIFF);
    if (c.type === "workspace.verify") reply(verify);
    if (c.type === "workspace.merge") reply(c.phase === "prepare" ? PREPARED : { status: "merged", commit: PREPARED.commit });
    if (c.type === "workspace.carried") reply({ carried: [] });
    if (c.type === "workspace.migrations") reply({ needed: false, reason: "Nothing taken." });
    return true;
  }, ["carried-check"]);
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
  const records = async () => (await db.select({ text: ticketMessages.text, author: ticketMessages.author }).from(ticketMessages).where(eq(ticketMessages.ticketId, t.id))).filter((m) => m.author === "system").map((m) => m.text);
  return { ...built, db, req, ticket: t, records };
}

describe("a bounce stays readable on the ticket (BOS-1723)", () => {
  it("a failed queued merge check leaves its job id and failing lines in the conversation, after the wake note is gone", async () => {
    const c = await setup(FAIL);
    await c.db.insert(settings).values({ key: "check_queue_mode", value: "server" });
    const res = approveAndWait(c.req, c.ticket.id);
    let job: typeof checkJobs.$inferSelect | undefined;
    for (let i = 0; i < 100 && !job; i++) {
      [job] = await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
      if (!job) await new Promise((r) => setTimeout(r, 20));
    }
    // Plays the dispatcher: the runner ran the job and it failed, with a log longer than the tail.
    await c.db.update(checkJobs).set({ state: "running", startedAt: new Date() }).where(eq(checkJobs.id, job!.id));
    const whole = `${FAIL.output}${"passing line\n".repeat(2_000)}`;
    await checkQueue(c.db).complete(job!.id, { runnerId: null, commit: job!.commit, exitCode: 1, logTail: whole.slice(-8192), fullLog: whole });
    expect((await res).json()).toMatchObject({ outcome: "verify_failed" });

    await c.db.delete(wakes);
    const [rec] = await c.records();
    expect(rec).toContain(`Job ${job!.id}`);
    expect(rec).toContain(`jobId ${job!.id}`);
    expect(rec).toContain("first failing test: src/limit.test.ts > limits > counts");
    // The agent's view of the conversation (first 1500 characters of a message) still has the job id.
    const talk = (await conversationLines(c.db, c.ticket.id)).join("\n");
    expect(talk).toContain(`Job ${job!.id}`);
  });

  it("a check run outside the queue says it has no job id and still keeps the failing lines", async () => {
    const c = await setup(FAIL);
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
    const [rec] = await c.records();
    expect(rec).toContain("Merge check bounced: `pnpm test` exited with code 1");
    expect(rec).toContain("No job id");
    expect(rec).toContain("> AssertionError: expected 1 to be 2");
  });
});

describe("bounce records", () => {
  it("stay under the cap, put the job id first, and redact secrets", () => {
    // Made-up value for this test, not a credential.
    const out = `MY_API_KEY=hunter2fakevalue error here\n${Array.from({ length: 500 }, (_, i) => `Error: line ${i} ${"x".repeat(200)}`).join("\n")}`;
    const rec = gateBounceRecord({ command: "pnpm test", why: "exited with code 1", output: out, jobId: "11111111-1111-4111-8111-111111111111", ticketId: "t" });
    expect(rec.length).toBeLessThanOrEqual(BOUNCE_RECORD_MAX);
    expect(rec.slice(0, 200)).toContain("Job 11111111-1111-4111-8111-111111111111");
    expect(rec).not.toContain("hunter2fakevalue");
    const ci = ciBounceRecord({ commit: "e".repeat(40), target: "main", body: "- check (https://github.com/example/site/actions/runs/1/job/2)\n  > FAIL a.test.ts\n".repeat(200) });
    expect(ci.length).toBeLessThanOrEqual(BOUNCE_RECORD_MAX);
    expect(ci).toContain("merge commit eeeeeeeeeeee");
  });

  it("show the last lines when nothing in the log looks like a failure", () => {
    const rec = gateBounceRecord({ command: "pnpm test", why: "exited with code 137", output: "one\ntwo\nkilled", ticketId: "t" });
    expect(rec).toContain("Last lines:\n> one\n> two\n> killed");
  });
});
