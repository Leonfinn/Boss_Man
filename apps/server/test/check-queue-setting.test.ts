// The owner's switch for the server-owned check queue (BOS-798, DR-003): Settings → Server and runner → Checks.
// Owner only; legacy and one slot by default; switching on starts waiting jobs, switching back cancels them with a reason.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, tickets, wakes } from "../src/db/schema.js";
import { checkQueue } from "../src/services/check-queue.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(features: string[]) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" } as never);
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true), features);
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Work", assigneeAgentId: ceo.id })).json() as { id: string };
  await db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, ticket.id));
  const queue = checkQueue(db);
  const enqueue = (tree: string) => queue.enqueue({ companyId: company.id, projectId: project.id, ticketId: ticket.id, kind: "pre_review", scope: "quick", commit: `c-${tree}`, tree, requestedBy: ceo.id });
  return { ...built, db, close, req, company, ceo, sent, queue, enqueue, runnerId: reg.runnerId };
}

describe("the check queue switch (BOS-798)", () => {
  it("is legacy with one slot until the owner changes it, and names a connected runner too old to run queued checks", async () => {
    const c = (ctx = await setup([]));
    expect((await c.req("GET", "/api/settings/check-queue")).json()).toEqual({ mode: "legacy", slots: 1, runner: null, maxSlots: 8, defaultSlots: 1, runnersTooOld: ["App Co"] });
  });

  it("is owner only: no session, no read and no change", async () => {
    const c = (ctx = await setup(["check-jobs"]));
    expect((await c.app.inject({ method: "GET", url: "/api/settings/check-queue" })).statusCode).toBe(401);
    expect((await c.app.inject({ method: "PUT", url: "/api/settings/check-queue", payload: { mode: "server", slots: 1 } })).statusCode).toBe(401);
    expect(await c.queue.mode()).toBe("legacy");
  });

  it("refuses a mode it doesn't know and slots outside 1 to 8", async () => {
    const c = (ctx = await setup(["check-jobs"]));
    for (const body of [{ mode: "on", slots: 1 }, { mode: "server", slots: 0 }, { mode: "server", slots: 9 }, { mode: "server", slots: 1.5 }, { mode: "server" }])
      expect((await c.req("PUT", "/api/settings/check-queue", body)).statusCode).toBe(400);
    expect(await c.queue.mode()).toBe("legacy");
  });

  it("switching to server saves both settings and starts a job already waiting on the runner", async () => {
    const c = (ctx = await setup(["check-jobs"]));
    const { job } = await c.enqueue("t1");
    expect(c.sent.filter((s) => s.type === "check.run")).toHaveLength(0);
    const r = await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 2 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mode: "server", slots: 2, runnersTooOld: [], cancelled: 0 });
    expect(await c.queue.slots()).toBe(2);
    expect(c.sent.filter((s) => s.type === "check.run").map((s) => (s as { jobId: string }).jobId)).toEqual([job.id]);
  });

  it("switching back to legacy cancels waiting jobs with a reason and wakes whoever asked; a running job is left to finish", async () => {
    const c = (ctx = await setup(["check-jobs"]));
    await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 1 });
    const running = (await c.enqueue("t1")).job;
    await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 1 }); // pumps: t1 takes the one slot
    const waiting = (await c.enqueue("t2")).job;
    expect(waiting.state).toBe("queued");
    const r = await c.req("PUT", "/api/settings/check-queue", { mode: "legacy", slots: 1 });
    expect(r.json()).toMatchObject({ mode: "legacy", cancelled: 1 });
    const rows = await c.db.select().from(checkJobs);
    expect(rows.find((j) => j.id === running.id)!.state).toBe("running");
    const gone = rows.find((j) => j.id === waiting.id)!;
    expect(gone.state).toBe("cancelled");
    expect(gone.reason).toMatch(/switched the check queue off/);
    const told = (await c.db.select().from(wakes)).filter((w) => w.agentId === c.ceo.id && w.reason === "check_result");
    expect(told.map((w) => w.note).join("\n")).toMatch(/switched the check queue off/);
    // Saving legacy again (already legacy) cancels nothing more.
    expect((await c.req("PUT", "/api/settings/check-queue", { mode: "legacy", slots: 1 })).json()).toMatchObject({ cancelled: 0 });
  });

  it("server → legacy → server never sends a job twice, never starts a cancelled one, and a running job's result still lands", async () => {
    const c = (ctx = await setup(["check-jobs"]));
    const runs = () => c.sent.filter((s) => s.type === "check.run").map((s) => (s as { jobId: string }).jobId);
    await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 1 });
    const running = (await c.enqueue("t1")).job;
    await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 1 });
    const waiting = (await c.enqueue("t2")).job;
    expect(runs()).toEqual([running.id]);
    await c.req("PUT", "/api/settings/check-queue", { mode: "legacy", slots: 1 });
    // Back on, twice: the running job is not sent again and the cancelled one stays cancelled.
    await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 1 });
    await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 2 });
    await c.checks.pump();
    expect(runs()).toEqual([running.id]);
    expect((await c.db.select().from(checkJobs).where(eq(checkJobs.id, waiting.id)))[0]!.state).toBe("cancelled");
    // The running job finishes (with the queue switched off meanwhile, as in the owner flipping it mid-run) and its agent is told.
    await c.req("PUT", "/api/settings/check-queue", { mode: "legacy", slots: 1 });
    await c.checks.onDone(c.runnerId, { jobId: running.id, commit: "c-t1", exitCode: 0, timedOut: false, tail: "ok" });
    expect((await c.db.select().from(checkJobs).where(eq(checkJobs.id, running.id)))[0]!.state).toBe("passed");
    const told = (await c.db.select().from(wakes)).filter((w) => w.agentId === c.ceo.id && w.reason === "check_result");
    expect(told.some((w) => /passed/.test(w.note ?? ""))).toBe(true);
  });
});
