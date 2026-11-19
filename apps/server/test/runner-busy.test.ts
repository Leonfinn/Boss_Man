// BOS-1845: what keeps a runner busy (runner-busy.ts, BOS-1471). The runner drain and the quiet-host wait of a server update
// both read it, so the two rules are pinned here on seeded rows: `workOnly` (owner chat and CEO reply runs never hold a swap)
// and `onRunnerOnly` (jobs on a separate check worker never hold a runner swap). All rows are made up; no clocks involved.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import type { Db } from "../src/db/client.js";
import { checkJobs, checkWorkers, companies, projects, runs, tickets } from "../src/db/schema.js";
import { checkJobsByCompany, runnerBusy, runnerChecks, runsByCompany } from "../src/services/runner-busy.js";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await openPglite());
});
afterEach(async () => {
  await close();
});

async function seedCompany(name: string, prefix: string | null = null) {
  const [c] = await db.insert(companies).values({ name, ...(prefix ? { ticketPrefix: prefix } : {}) }).returning();
  const [p] = await db.insert(projects).values({ companyId: c!.id, name: `${name} project` }).returning();
  const [t] = await db.insert(tickets).values({ companyId: c!.id, projectId: p!.id, title: `${name} work` }).returning();
  return { companyId: c!.id, projectId: p!.id, ticketId: t!.id, ticketNumber: t!.number };
}
type Seed = Awaited<ReturnType<typeof seedCompany>>;

const run = (s: Seed, purpose: string | null, ended = false) => db.insert(runs).values({ companyId: s.companyId, purpose, ...(ended ? { endedAt: new Date() } : {}) });
const job = (s: Seed, state: string, opts: { workerId?: string; kind?: string; scope?: string; startedAt?: Date; endedAt?: Date } = {}) =>
  db.insert(checkJobs).values({
    companyId: s.companyId,
    projectId: s.projectId,
    ticketId: s.ticketId,
    kind: opts.kind ?? "merge",
    scope: opts.scope ?? "full",
    commit: "abc",
    tree: randomUUID(),
    state,
    workerId: opts.workerId ?? null,
    startedAt: opts.startedAt ?? null,
    endedAt: opts.endedAt ?? null,
  });
async function worker() {
  const [w] = await db.insert(checkWorkers).values({ name: "worker-1", tokenHash: randomUUID() }).returning();
  return w!.id;
}

describe("runsByCompany", () => {
  it("counts only live runs, per company", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    await run(a, "work");
    await run(a, null);
    await run(a, "work", true);
    await run(b, "work");
    expect(await runsByCompany(db)).toEqual(new Map([[a.companyId, 2], [b.companyId, 1]]));
  });

  it("workOnly leaves out chat and reply runs but keeps runs with no purpose", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    await run(a, "chat");
    await run(a, "reply");
    await run(a, "work");
    await run(a, null);
    await run(b, "chat");
    const all = await runsByCompany(db);
    expect(all.get(a.companyId)).toBe(4);
    expect(all.get(b.companyId)).toBe(1);
    const work = await runsByCompany(db, true);
    expect(work.get(a.companyId)).toBe(2);
    expect(work.has(b.companyId)).toBe(false); // a company with only chat runs is not listed
  });

  it("is empty when nothing is live", async () => {
    const a = await seedCompany("Alpha");
    await run(a, "work", true);
    expect((await runsByCompany(db)).size).toBe(0);
  });
});

describe("checkJobsByCompany", () => {
  it("counts only running jobs; queued and finished ones do not hold anything", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    await job(a, "running");
    await job(a, "running");
    await job(a, "queued");
    await job(a, "passed", { endedAt: new Date() });
    await job(a, "failed", { endedAt: new Date() });
    await job(b, "running");
    expect(await checkJobsByCompany(db)).toEqual(new Map([[a.companyId, 2], [b.companyId, 1]]));
  });

  it("onRunnerOnly leaves out jobs on a check worker", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const w = await worker();
    await job(a, "running");
    await job(a, "running", { workerId: w });
    await job(b, "running", { workerId: w });
    expect((await checkJobsByCompany(db)).get(a.companyId)).toBe(2);
    expect((await checkJobsByCompany(db)).get(b.companyId)).toBe(1);
    const onRunner = await checkJobsByCompany(db, true);
    expect(onRunner.get(a.companyId)).toBe(1);
    expect(onRunner.has(b.companyId)).toBe(false);
  });
});

describe("runnerBusy", () => {
  it("adds work runs and running checks per company, with totals, and ignores chat and reply runs", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    await run(a, "work");
    await run(a, "chat");
    await run(b, "reply");
    await job(a, "running");
    await job(b, "running");
    await job(b, "running");
    const busy = await runnerBusy(db);
    expect(busy.runs).toEqual(new Map([[a.companyId, 1]]));
    expect(busy.checks).toEqual(new Map([[a.companyId, 1], [b.companyId, 2]]));
    expect(busy.byCompany).toEqual(new Map([[a.companyId, 2], [b.companyId, 2]]));
    expect(busy.runsTotal).toBe(1);
    expect(busy.checksTotal).toBe(3);
  });

  it("a company with only a check on a worker is busy for the update wait but not for a runner swap", async () => {
    const a = await seedCompany("Alpha");
    const w = await worker();
    await job(a, "running", { workerId: w });
    const update = await runnerBusy(db);
    expect(update.byCompany.get(a.companyId)).toBe(1);
    expect(update.checksTotal).toBe(1);
    const swap = await runnerBusy(db, true);
    expect(swap.byCompany.size).toBe(0);
    expect(swap.checksTotal).toBe(0);
  });

  it("an idle server gives empty maps and zero totals", async () => {
    const busy = await runnerBusy(db);
    expect(busy.byCompany.size).toBe(0);
    expect(busy.runsTotal + busy.checksTotal).toBe(0);
  });
});

describe("runnerChecks", () => {
  const AT = new Date("2026-01-01T12:00:00Z");
  const minutesBefore = (m: number) => new Date(AT.getTime() - m * 60_000);

  it("lists running checks on a runner, oldest first, with the ticket ref and minutes running; skips worker and queued jobs", async () => {
    const a = await seedCompany("Alpha", "ALP");
    const w = await worker();
    await job(a, "running", { kind: "merge", scope: "full", startedAt: minutesBefore(5) });
    await job(a, "running", { kind: "pre_review", scope: "quick", startedAt: minutesBefore(20) });
    await job(a, "running", { workerId: w, startedAt: minutesBefore(30) });
    await job(a, "queued");
    const out = await runnerChecks(db, AT);
    expect(out.map((c) => c.kind)).toEqual(["pre_review", "merge"]);
    expect(out[0]).toMatchObject({ ticket: `ALP-${a.ticketNumber}`, scope: "quick", runningForMinutes: 20, startedAt: minutesBefore(20).toISOString(), usuallyMinutes: null });
    expect(out[1]!.runningForMinutes).toBe(5);
  });

  it("falls back to the ticket prefix T when the company has none", async () => {
    const a = await seedCompany("Alpha");
    await db.update(companies).set({ ticketPrefix: "" });
    await job(a, "running", { startedAt: minutesBefore(1) });
    const [c] = await runnerChecks(db, AT);
    expect(c!.ticket).toBe(`T-${a.ticketNumber}`);
  });

  it("usuallyMinutes is the mean of the last five passed checks of the same kind and scope, at least 1", async () => {
    const a = await seedCompany("Alpha");
    await job(a, "running", { kind: "merge", scope: "full", startedAt: minutesBefore(2) });
    // Six passed merge/full checks: one old 100-minute outlier, then five of 10 minutes; only the newest five count.
    await job(a, "passed", { kind: "merge", scope: "full", startedAt: new Date("2025-12-01T00:00:00Z"), endedAt: new Date("2025-12-01T01:40:00Z") });
    for (let i = 0; i < 5; i++) {
      const start = new Date(Date.UTC(2025, 11, 10 + i, 0, 0, 0));
      await job(a, "passed", { kind: "merge", scope: "full", startedAt: start, endedAt: new Date(start.getTime() + 10 * 60_000) });
    }
    // Other kind/scope and failed jobs are not part of the mean.
    await job(a, "passed", { kind: "merge", scope: "quick", startedAt: new Date("2025-12-20T00:00:00Z"), endedAt: new Date("2025-12-20T03:00:00Z") });
    await job(a, "failed", { kind: "merge", scope: "full", startedAt: new Date("2025-12-21T00:00:00Z"), endedAt: new Date("2025-12-21T03:00:00Z") });
    const [c] = await runnerChecks(db, AT);
    expect(c!.usuallyMinutes).toBe(10);
  });

  it("a very short usual run rounds up to 1 minute, and a job with no start time shows 0 minutes", async () => {
    const a = await seedCompany("Alpha");
    await job(a, "running", { kind: "pre_review", scope: "quick" });
    await job(a, "passed", { kind: "pre_review", scope: "quick", startedAt: new Date("2025-12-01T00:00:00Z"), endedAt: new Date("2025-12-01T00:00:05Z") });
    const [c] = await runnerChecks(db, AT);
    expect(c).toMatchObject({ startedAt: null, runningForMinutes: 0, usuallyMinutes: 1 });
  });

  it("never reports a negative running time when the clock is before the start", async () => {
    const a = await seedCompany("Alpha");
    await job(a, "running", { startedAt: minutesBefore(-10) });
    const [c] = await runnerChecks(db, AT);
    expect(c!.runningForMinutes).toBe(0);
  });

  it("is empty with nothing running", async () => {
    expect(await runnerChecks(db, AT)).toEqual([]);
  });
});
