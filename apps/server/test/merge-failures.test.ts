// BOS-1461: failed merge attempts are recorded with a reason, counted by reason, and three of one reason in
// 30 minutes raise one CEO alert that carries its cleared-when condition.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, projects, tickets } from "../src/db/schema.js";
import { activity } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { clearWhenOf } from "../src/services/alert-clearing.js";
import { failedSince, failuresForStatus, recordFailedAttempt } from "../src/services/merge-failures.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
let t: { id: string; companyId: string };

beforeEach(async () => {
  ({ db, close } = await openPglite());
  const [c] = await db.insert(companies).values({ name: "Co" }).returning();
  const [p] = await db.insert(projects).values({ companyId: c!.id, name: "App" }).returning();
  const [row] = await db.insert(tickets).values({ companyId: c!.id, projectId: p!.id, title: "T", systemState: "review" }).returning();
  t = { id: row!.id, companyId: c!.id };
});
afterEach(async () => {
  await close();
});

describe("failed merge attempts", () => {
  it("records attempt_failed with the reason and job id", async () => {
    await recordFailedAttempt(db, {}, t, "check_failed", "job-1");
    const [r] = await db.select().from(activity).where(eq(activity.ticketId, t.id));
    expect(r!.detail).toMatchObject({ event: "attempt_failed", reason: "check_failed", jobId: "job-1" });
  });

  it("counts the last hour by reason", async () => {
    const now = new Date("2026-11-14T12:00:00Z");
    await recordFailedAttempt(db, { now: () => new Date(now.getTime() - 90 * 60_000) }, t, "conflict");
    await recordFailedAttempt(db, { now: () => new Date(now.getTime() - 10 * 60_000) }, t, "conflict");
    await recordFailedAttempt(db, { now: () => new Date(now.getTime() - 5 * 60_000) }, t, "restart");
    expect(await failuresForStatus(db, t.companyId, now)).toEqual({ lastHour: 2, byReason: { conflict: 1, restart: 1 } });
  });

  it("raises one alert on the third failure of a reason, with a cleared-when condition", async () => {
    const raised: Array<Record<string, unknown>> = [];
    const alert = async (i: Record<string, unknown>) => void raised.push(i);
    const now = new Date("2026-11-14T12:00:00Z");
    for (const mins of [20, 10]) await recordFailedAttempt(db, { alert, now: () => new Date(now.getTime() - mins * 60_000) }, t, "main_moved");
    await recordFailedAttempt(db, { alert, now: () => new Date(now.getTime() - 5 * 60_000) }, t, "conflict");
    expect(raised).toHaveLength(0);
    await recordFailedAttempt(db, { alert, now: () => now }, t, "main_moved");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: "merge_failures", from: "ceo", dedupeKey: `merge-failures:${t.companyId}:main_moved`, clearWhen: [{ kind: "mergeFailuresCalm", reason: "main_moved" }] });
    expect(clearWhenOf({ clearWhen: raised[0]!.clearWhen })).toHaveLength(1);
  });

  it("does not alert when the three are more than 30 minutes apart", async () => {
    const raised: unknown[] = [];
    const alert = async (i: Record<string, unknown>) => void raised.push(i);
    const now = new Date("2026-11-14T12:00:00Z");
    for (const mins of [100, 60, 0]) await recordFailedAttempt(db, { alert, now: () => new Date(now.getTime() - mins * 60_000) }, t, "gate_fault");
    expect(raised).toHaveLength(0);
  });

  it("failedSince tells calm from not calm", async () => {
    const now = new Date("2026-11-14T12:00:00Z");
    await recordFailedAttempt(db, { now: () => new Date(now.getTime() - 40 * 60_000) }, t, "restart");
    expect(await failedSince(db, t.companyId, "restart", new Date(now.getTime() - 30 * 60_000))).toBe(false);
    expect(await failedSince(db, t.companyId, "restart", new Date(now.getTime() - 60 * 60_000))).toBe(true);
  });
});
