// The owner's switch for the server-owned check queue (BOS-798, DR-003): Settings → Server and runner → Checks.
// Owner only; legacy and one slot by default; switching on starts waiting jobs, switching back cancels them with a reason.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, tickets, wakes } from "../src/db/schema.js";
import { checkQueue, DEFAULT_SLOT_POLICY, isDefaultPolicy, MAX_CHECK_SLOTS, readPolicy, slotShape, type SlotPolicy } from "../src/services/check-queue.js";

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
    expect((await c.req("GET", "/api/settings/check-queue")).json()).toEqual({ mode: "legacy", slots: 1, effectiveSlots: 1, runnerSlotsReported: null, runner: null, maxSlots: 8, defaultSlots: 1, runnersTooOld: ["App Co"], train: false, runnersTooOldForTrain: ["App Co"], laneAgeMinutes: 120, defaultLaneAgeMinutes: 120, runnerPolicy: { takes: "both", mergeKept: 0 }, workers: [] });
  });

  it("background lane wait (BOS-1803): 120 min by default, saved when sent, left alone by a page that doesn't send it, 0 to 1440", async () => {
    const c = (ctx = await setup(["check-jobs", "merge-base"]));
    const put = (body: object) => c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 2, ...body });
    expect((await put({ laneAgeMinutes: 45 })).json()).toMatchObject({ laneAgeMinutes: 45 });
    expect((await put({})).json()).toMatchObject({ laneAgeMinutes: 45 });
    expect((await put({ laneAgeMinutes: 0 })).json()).toMatchObject({ laneAgeMinutes: 0 });
    for (const bad of [-1, 1441, 2.5]) expect((await put({ laneAgeMinutes: bad })).statusCode).toBe(400);
    expect(await c.queue.laneAge()).toBe(0);
  });

  it("runner split (BOS-1602): both kinds, none kept until set; saved when sent, left alone by a page that doesn't send it; kept can't exceed the slots", async () => {
    const c = (ctx = await setup(["check-jobs", "merge-base"]));
    const put = (body: object) => c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 3, ...body });
    expect((await put({ runnerPolicy: { takes: "both", mergeKept: 2 } })).json()).toMatchObject({ runnerPolicy: { takes: "both", mergeKept: 2 } });
    expect((await put({})).json()).toMatchObject({ runnerPolicy: { takes: "both", mergeKept: 2 } });
    expect((await put({ runnerPolicy: { takes: "both", mergeKept: 4 } })).statusCode).toBe(400);
    expect((await put({ runnerPolicy: { takes: "sometimes", mergeKept: 0 } })).statusCode).toBe(400);
    // Kept slots mean nothing for a one-kind machine, so they are stored as 0.
    expect((await put({ runnerPolicy: { takes: "merge", mergeKept: 2 } })).json()).toMatchObject({ runnerPolicy: { takes: "merge", mergeKept: 0 } });
    expect(await c.queue.runnerPolicy()).toEqual({ takes: "merge", mergeKept: 0 });
  });

  it("merge train switch (BOS-1366): off by default, saved when sent, left alone by a page that doesn't send it", async () => {
    const c = (ctx = await setup(["check-jobs", "merge-base"]));
    expect((await c.req("GET", "/api/settings/check-queue")).json()).toMatchObject({ train: false, runnersTooOldForTrain: [] });
    expect((await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 2, train: true })).json()).toMatchObject({ train: true });
    expect((await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 2 })).json()).toMatchObject({ train: true });
    expect(await c.queue.train()).toBe(true);
    expect((await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 2, train: false })).json()).toMatchObject({ train: false });
    expect((await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 2, train: "yes" })).statusCode).toBe(400);
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

// The pure helpers behind the owner's per-machine split (BOS-1602): what a stored policy means, whether it is the
// default, and how its slots divide between merges, checks and either kind. No database, clock or network.
describe("machine slot policy helpers (BOS-1602)", () => {
  const both = (mergeKept: number): SlotPolicy => ({ takes: "both", mergeKept });

  it("readPolicy keeps a valid stored policy", () => {
    expect(readPolicy({ takes: "both", mergeKept: 2 })).toEqual({ takes: "both", mergeKept: 2 });
    expect(readPolicy({ takes: "merge", mergeKept: 0 })).toEqual({ takes: "merge", mergeKept: 0 });
    expect(readPolicy({ takes: "checks", mergeKept: 0 })).toEqual({ takes: "checks", mergeKept: 0 });
    // Kept slots mean nothing for a one-kind machine, so they read as 0 whatever was stored.
    expect(readPolicy({ takes: "merge", mergeKept: 3 })).toEqual({ takes: "merge", mergeKept: 0 });
    expect(readPolicy({ takes: "checks", mergeKept: 3 })).toEqual({ takes: "checks", mergeKept: 0 });
  });

  it("readPolicy reads a missing value as the default", () => {
    expect(readPolicy(undefined)).toEqual(DEFAULT_SLOT_POLICY);
    expect(readPolicy(null)).toEqual(DEFAULT_SLOT_POLICY);
    expect(readPolicy({})).toEqual(DEFAULT_SLOT_POLICY);
    expect(readPolicy({ takes: "both" })).toEqual(DEFAULT_SLOT_POLICY);
  });

  it("readPolicy reads junk as the default rather than throwing", () => {
    expect(readPolicy("nonsense")).toEqual(DEFAULT_SLOT_POLICY);
    expect(readPolicy(42)).toEqual(DEFAULT_SLOT_POLICY);
    expect(readPolicy([])).toEqual(DEFAULT_SLOT_POLICY);
    // A takes it doesn't know is "both"; the kept count is then read on its own.
    expect(readPolicy({ takes: "sometimes", mergeKept: 0 })).toEqual(DEFAULT_SLOT_POLICY);
    for (const junk of ["many", {}, [], 2.5, -3, 0]) expect(readPolicy({ takes: "both", mergeKept: junk })).toEqual(DEFAULT_SLOT_POLICY);
  });

  it("readPolicy clamps a kept count above the most slots a machine may have", () => {
    expect(readPolicy({ takes: "both", mergeKept: MAX_CHECK_SLOTS + 5 })).toEqual({ takes: "both", mergeKept: MAX_CHECK_SLOTS });
  });

  it("isDefaultPolicy is true only for both kinds with nothing kept", () => {
    expect(isDefaultPolicy(DEFAULT_SLOT_POLICY)).toBe(true);
    expect(isDefaultPolicy(both(0))).toBe(true);
    expect(isDefaultPolicy(both(-1))).toBe(true);
    expect(isDefaultPolicy(both(1))).toBe(false);
    expect(isDefaultPolicy({ takes: "merge", mergeKept: 0 })).toBe(false);
    expect(isDefaultPolicy({ takes: "checks", mergeKept: 0 })).toBe(false);
  });

  it("slotShape divides the slots: one slot, and a normal limit with nothing kept", () => {
    expect(slotShape(1, DEFAULT_SLOT_POLICY)).toEqual({ mergeOnly: 0, checkOnly: 0, either: 1 });
    expect(slotShape(4, DEFAULT_SLOT_POLICY)).toEqual({ mergeOnly: 0, checkOnly: 0, either: 4 });
  });

  it("slotShape gives every slot to a one-kind machine", () => {
    expect(slotShape(3, { takes: "merge", mergeKept: 0 })).toEqual({ mergeOnly: 3, checkOnly: 0, either: 0 });
    expect(slotShape(3, { takes: "checks", mergeKept: 0 })).toEqual({ mergeOnly: 0, checkOnly: 3, either: 0 });
    // Kept slots are ignored on a one-kind machine.
    expect(slotShape(3, { takes: "checks", mergeKept: 2 })).toEqual({ mergeOnly: 0, checkOnly: 3, either: 0 });
  });

  it("slotShape keeps the merges then hands the rest to either kind, and always adds up to the limit", () => {
    expect(slotShape(3, both(2))).toEqual({ mergeOnly: 2, checkOnly: 0, either: 1 });
    expect(slotShape(1, both(1))).toEqual({ mergeOnly: 1, checkOnly: 0, either: 0 });
    for (const limit of [1, 2, 5, 8])
      for (const p of [DEFAULT_SLOT_POLICY, both(1), both(3), { takes: "merge", mergeKept: 0 }, { takes: "checks", mergeKept: 0 }] as SlotPolicy[]) {
        const s = slotShape(limit, p);
        expect(s.mergeOnly + s.checkOnly + s.either).toBe(limit);
      }
  });

  it("slotShape clamps kept slots to the limit and floors a fractional count", () => {
    // The owner asked for more kept slots than the machine now reports.
    expect(slotShape(2, both(5))).toEqual({ mergeOnly: 2, checkOnly: 0, either: 0 });
    expect(slotShape(3, both(1.9))).toEqual({ mergeOnly: 1, checkOnly: 0, either: 2 });
    expect(slotShape(3, both(-2))).toEqual({ mergeOnly: 0, checkOnly: 0, either: 3 });
  });
});
