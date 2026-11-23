// BOS-2328: "Start now" and "Cancel" on a waiting wake, each with the owner's reason in the activity log.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { activity, agents, companies, wakes } from "../src/db/schema.js";
import { runsService, RunError } from "../src/services/runs.js";

let close: () => Promise<void>;
let svc: ReturnType<typeof runsService>;
let db: Awaited<ReturnType<typeof openPglite>>["db"];
let companyId: string;
let otherId: string;
let agentId: string;
let otherAgent: string;

const mk = async (over: Partial<typeof wakes.$inferInsert> = {}) => (await db.insert(wakes).values({ companyId, agentId, reason: "assigned", ...over }).returning())[0]!;

beforeAll(async () => {
  const pg = await openPglite(undefined, { fresh: true });
  close = pg.close;
  db = pg.db;
  const [co] = await db.insert(companies).values({ name: "Example Co" }).returning();
  const [other] = await db.insert(companies).values({ name: "Other Co" }).returning();
  companyId = co!.id;
  otherId = other!.id;
  agentId = (await db.insert(agents).values({ companyId, name: "Ada", role: "worker", agentKind: "claude" }).returning())[0]!.id;
  otherAgent = (await db.insert(agents).values({ companyId: otherId, name: "Bo", role: "worker", agentKind: "claude" }).returning())[0]!.id;
  svc = runsService(db, { runners: {} as never });
});
afterAll(async () => close?.());

describe("start now", () => {
  it("clears a deferred wake's hold and logs the owner's reason", async () => {
    const w = await mk({ status: "deferred", statusReason: "quiet hours", notBefore: new Date(Date.now() + 3_600_000) });
    await svc.startWaiting(companyId, w.id, "urgent fix");
    const [after] = await db.select().from(wakes).where(eq(wakes.id, w.id));
    expect(after).toMatchObject({ status: "queued", statusReason: null, notBefore: null });
    const [log] = await db.select().from(activity).where(eq(activity.kind, "wake_start_now"));
    expect(log).toMatchObject({ companyId, agentId: null });
    expect(log!.summary).toContain("urgent fix");
    expect(log!.detail).toMatchObject({ actor: "owner", wakeId: w.id });
  });

  it("refuses another company's wake and leaves it untouched", async () => {
    const w = await db.insert(wakes).values({ companyId: otherId, agentId: otherAgent, reason: "assigned", status: "deferred", statusReason: "held" }).returning();
    await expect(svc.startWaiting(companyId, w[0]!.id)).rejects.toBeInstanceOf(RunError);
    const [after] = await db.select().from(wakes).where(eq(wakes.id, w[0]!.id));
    expect(after!.status).toBe("deferred");
  });

  it("refuses a wake that already started", async () => {
    const w = await mk({ status: "launched", runId: "00000000-0000-4000-8000-000000000001" });
    await expect(svc.startWaiting(companyId, w.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("cancel", () => {
  it("removes the wake and logs the reason", async () => {
    const w = await mk();
    await svc.cancelWaiting(companyId, w.id, "not needed");
    expect(await db.select().from(wakes).where(eq(wakes.id, w.id))).toHaveLength(0);
    const rows = await db.select().from(activity).where(eq(activity.kind, "wake_cancelled"));
    expect(rows[0]!.summary).toContain("not needed");
  });

  it("will not remove another company's wake", async () => {
    const w = await db.insert(wakes).values({ companyId: otherId, agentId: otherAgent, reason: "assigned" }).returning();
    await expect(svc.cancelWaiting(companyId, w[0]!.id)).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(wakes).where(eq(wakes.id, w[0]!.id))).toHaveLength(1);
  });
});
