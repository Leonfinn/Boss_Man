// BOS-1845: the text an agent reads about its failed checks (check-failures.ts, BOS-1723): the gate's failed and stuck jobs
// and GitHub CI failures, newest first, scoped to one company's ticket. Made-up rows; the "first failing line" comes from
// the job's reason (no log tail), so the test does not depend on how a log is scanned.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import type { Db } from "../src/db/client.js";
import { checkJobLogs, checkJobs, checkResults, companies, projects, tickets } from "../src/db/schema.js";
import { failedChecksText } from "../src/services/check-failures.js";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await openPglite());
});
afterEach(async () => {
  await close();
});

async function seed(name: string) {
  const [c] = await db.insert(companies).values({ name }).returning();
  const [p] = await db.insert(projects).values({ companyId: c!.id, name: `${name} project` }).returning();
  const [t] = await db.insert(tickets).values({ companyId: c!.id, projectId: p!.id, title: `${name} work` }).returning();
  return { companyId: c!.id, projectId: p!.id, ticketId: t!.id };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
async function job(s: Seed, o: { state: string; kind?: string; scope?: string; endedAt?: Date | null; reason?: string | null; logChars?: number }) {
  const [j] = await db
    .insert(checkJobs)
    .values({ companyId: s.companyId, projectId: s.projectId, ticketId: s.ticketId, kind: o.kind ?? "merge", scope: o.scope ?? "full", commit: COMMIT, tree: randomUUID(), state: o.state, reason: o.reason ?? null, endedAt: o.endedAt === undefined ? new Date() : o.endedAt })
    .returning();
  if (o.logChars !== undefined) await db.insert(checkJobLogs).values({ jobId: j!.id, log: "x", chars: o.logChars });
  return j!.id;
}
const ci = (s: Seed, o: { at: Date; sha?: string | null; detail?: string | null; passed?: boolean; kind?: string }) =>
  db.insert(checkResults).values({ companyId: s.companyId, ticketId: s.ticketId, kind: o.kind ?? "ci", passed: o.passed ?? false, at: o.at, sha: o.sha === undefined ? "f".repeat(40) : o.sha, detail: o.detail === undefined ? "workflow failed: lint" : o.detail });

describe("failedChecksText", () => {
  it("is null when the ticket has no failed check, whatever else it has", async () => {
    const s = await seed("Alpha");
    await job(s, { state: "passed" });
    await job(s, { state: "queued", endedAt: null });
    await job(s, { state: "cancelled", reason: "no longer needed" });
    await ci(s, { at: new Date(), passed: true });
    await ci(s, { at: new Date(), kind: "verify" });
    expect(await failedChecksText(db, s.companyId, s.ticketId)).toBeNull();
  });

  it("names a failed job: id, kind, scope, commit cut to 12, time, first failing line and log size", async () => {
    const s = await seed("Alpha");
    const id = await job(s, { state: "failed", kind: "pre_review", scope: "quick", endedAt: new Date("2026-03-04T05:06:07Z"), reason: "typecheck failed in apps/web", logChars: 5000 });
    const text = await failedChecksText(db, s.companyId, s.ticketId);
    expect(text).toBe(
      [
        "Failed checks of this ticket, newest first (up to 20 of each kind). Open one with tickets check_log and its jobId:",
        `- job ${id}: quick check (quick) on 0123456789ab, failed 2026-03-04 05:06 UTC. First failing line: typecheck failed in apps/web Log kept (5 KB).`,
      ].join("\n"),
    );
  });

  it("says stuck for a stuck job, the plain kind for an unknown one, and notes a missing line, log and time", async () => {
    const s = await seed("Alpha");
    const id = await job(s, { state: "stuck", kind: "weird_kind", scope: "full", endedAt: null, reason: null });
    const text = (await failedChecksText(db, s.companyId, s.ticketId))!;
    expect(text).toContain(`- job ${id}: weird_kind (full) on 0123456789ab, stuck time unknown. No failing line named. No log kept.`);
  });

  it("shows a log under 1 KB as 1 KB, and cuts a long first line to 300 characters", async () => {
    const s = await seed("Alpha");
    await job(s, { state: "failed", reason: "z".repeat(500), logChars: 10 });
    const text = (await failedChecksText(db, s.companyId, s.ticketId))!;
    expect(text).toContain(`First failing line: ${"z".repeat(300)} Log kept (1 KB).`);
    expect(text).not.toContain("z".repeat(301));
  });

  it("names a GitHub CI failure, with its sha cut to 12 and a default detail, and skips passed ones", async () => {
    const s = await seed("Alpha");
    await ci(s, { at: new Date("2026-03-04T05:06:00Z"), detail: "workflow failed: lint" });
    await ci(s, { at: new Date("2026-03-05T05:06:00Z"), sha: null, detail: null });
    await ci(s, { at: new Date("2026-03-06T05:06:00Z"), passed: true, detail: "all green" });
    const lines = (await failedChecksText(db, s.companyId, s.ticketId))!.split("\n").slice(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^- GitHub CI on the merge commit \(unknown\), failed 2026-03-05 05:06 UTC: workflow failed\. Its log stays on GitHub;/);
    expect(lines[1]).toMatch(/^- GitHub CI on the merge commit ffffffffffff, failed 2026-03-04 05:06 UTC: workflow failed: lint\./);
  });

  it("merges jobs and CI failures newest first", async () => {
    const s = await seed("Alpha");
    const oldJob = await job(s, { state: "failed", endedAt: new Date("2026-03-01T00:00:00Z"), reason: "a" });
    await ci(s, { at: new Date("2026-03-02T00:00:00Z"), detail: "ci-middle" });
    const newJob = await job(s, { state: "failed", endedAt: new Date("2026-03-03T00:00:00Z"), reason: "b" });
    const lines = (await failedChecksText(db, s.companyId, s.ticketId))!.split("\n").slice(1);
    expect(lines[0]).toContain(newJob);
    expect(lines[1]).toContain("ci-middle");
    expect(lines[2]).toContain(oldJob);
  });

  it("keeps only the newest 20 of each kind", async () => {
    const s = await seed("Alpha");
    for (let i = 0; i < 22; i++) await job(s, { state: "failed", endedAt: new Date(Date.UTC(2026, 0, 1, 0, i)), reason: `job-${i}` });
    for (let i = 0; i < 22; i++) await ci(s, { at: new Date(Date.UTC(2026, 1, 1, 0, i)), detail: `ci-${i}` });
    const lines = (await failedChecksText(db, s.companyId, s.ticketId))!.split("\n").slice(1);
    expect(lines).toHaveLength(40);
    expect(lines.filter((l) => l.includes("GitHub CI"))).toHaveLength(20);
    expect(lines.some((l) => l.includes("ci-0:") || l.includes("ci-1:"))).toBe(false);
    expect(lines.some((l) => l.includes("job-0 ") || l.includes("job-1 "))).toBe(false);
    expect(lines.some((l) => l.includes("job-21"))).toBe(true);
  });

  it("only shows this company's ticket", async () => {
    const a = await seed("Alpha");
    const b = await seed("Beta");
    await job(a, { state: "failed", reason: "alpha-fail" });
    await ci(a, { at: new Date(), detail: "alpha-ci" });
    await job(b, { state: "failed", reason: "beta-fail" });
    const text = (await failedChecksText(db, b.companyId, b.ticketId))!;
    expect(text).toContain("beta-fail");
    expect(text).not.toContain("alpha");
    expect(await failedChecksText(db, b.companyId, a.ticketId)).toBeNull(); // right ticket, wrong company
  });
});
