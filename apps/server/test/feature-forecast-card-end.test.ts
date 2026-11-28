// BOS-2793: tests for two small, previously untested helpers.
// featureForecasts (a feature's points done and left, its unsized open tasks and an expected finish at the
// company's recent pace, shown on the Features page) and stampCardEnd (writes how a server update ended onto
// its card, so Recent updates never guesses).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, features, projects, tickets } from "../src/db/schema.js";
import { featureForecasts } from "../src/services/feature-forecast.js";
import { stampCardEnd } from "../src/services/card-end.js";
import { forecastMilestone, paceByCompany } from "../src/services/planning.js";

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db.insert(companies).values({ name: `Co ${randomUUID()}` }).returning();
  const [other] = await db.insert(companies).values({ name: `Other ${randomUUID()}` }).returning();
  const [project] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [otherProject] = await db.insert(projects).values({ companyId: other!.id, name: "Dev" }).returning();
  const feature = async (companyId: string) => (await db.insert(features).values({ companyId, title: `Feature ${randomUUID()}` }).returning())[0]!;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: project!.id, title: "T", systemState: "in_progress", ...patch }).returning())[0]!;
  const card = async (context: Record<string, unknown>) =>
    (await db.insert(decisions).values({ companyId: co!.id, kind: "question", question: "Q", recommendedOption: "A", context }).returning())[0]!;
  return { db, close, co: co!.id, other: other!.id, project: project!.id, otherProject: otherProject!.id, feature, ticket, card };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
let s: Ctx;

beforeEach(async () => {
  s = await setup();
});
afterEach(async () => {
  await s.close();
});

describe("featureForecasts", () => {
  const today = "2026-11-27";

  it("gives an empty map for an empty id list", async () => {
    const out = await featureForecasts(s.db, s.co, [], today);
    expect(out.size).toBe(0);
  });

  it("gives an entry for every id asked about, including a feature with no tickets", async () => {
    const empty = await s.feature(s.co);
    const busy = await s.feature(s.co);
    await s.ticket({ featureId: busy.id, size: 3, systemState: "ready" });
    const out = await featureForecasts(s.db, s.co, [empty.id, busy.id], today);
    expect(out.size).toBe(2);
    expect(out.get(empty.id)).toEqual({ pointsDone: 0, pointsLeft: 0, unsized: 0, pace: 0, expectedFinish: today });
    expect(out.get(busy.id)).toEqual({ pointsDone: 0, pointsLeft: 3, unsized: 0, pace: 0, expectedFinish: null });
  });

  it("counts sized done and open points and unsized open tasks, leaving out cancelled and other companies", async () => {
    const f = await s.feature(s.co);
    const anotherFeature = await s.feature(s.co);
    await s.ticket({ featureId: f.id, size: 3, systemState: "done", outcome: "completed" }); // done: 3 points
    await s.ticket({ featureId: f.id, size: 5, systemState: "in_progress" }); // left: 5 points
    await s.ticket({ featureId: f.id, size: null, systemState: "ready" }); // unsized open
    await s.ticket({ featureId: f.id, size: null, systemState: "done", outcome: "completed" }); // unsized, done: nothing
    await s.ticket({ featureId: f.id, size: 2, systemState: "done", outcome: "cancelled" }); // cancelled: out
    await s.ticket({ featureId: f.id, size: 8, systemState: "in_progress", outcome: "cancelled" }); // cancelled: out
    await s.ticket({ featureId: anotherFeature.id, size: 8, systemState: "in_progress" }); // another feature: out
    await s.db.insert(tickets).values({ companyId: s.other, projectId: s.otherProject, title: "Elsewhere", featureId: f.id, size: 8, systemState: "in_progress" }); // other company: out
    const got = (await featureForecasts(s.db, s.co, [f.id], today)).get(f.id)!;
    expect(got.pointsDone).toBe(3);
    expect(got.pointsLeft).toBe(5);
    expect(got.unsized).toBe(1);
  });

  it("has no pace and no expected finish when nothing was done in the last 28 days, while points are left", async () => {
    const f = await s.feature(s.co);
    await s.ticket({ featureId: f.id, size: 5, systemState: "in_progress" });
    // Done, but before the 28-day window, so it does not set a pace.
    await s.ticket({ featureId: f.id, size: 2, systemState: "done", outcome: "completed", stateChangedAt: new Date("2026-10-01T00:00:00Z") });
    const got = (await featureForecasts(s.db, s.co, [f.id], today)).get(f.id)!;
    expect(got.pointsLeft).toBe(5);
    expect(got.pace).toBe(0);
    expect(got.expectedFinish).toBeNull();
  });

  it("takes its pace and expected finish from forecastMilestone for the same tasks, and has no daysLate", async () => {
    const f = await s.feature(s.co);
    await s.ticket({ featureId: f.id, size: 5, systemState: "done", outcome: "completed", stateChangedAt: new Date("2026-11-20T00:00:00Z") });
    await s.ticket({ featureId: f.id, size: 3, systemState: "in_progress" });
    await s.ticket({ featureId: f.id, size: null, systemState: "ready" });
    const rows = [
      { size: 5, done: true },
      { size: 3, done: false },
      { size: null, done: false },
    ];
    const pace = (await paceByCompany(s.db, today)).get(s.co) ?? 0;
    const expected = forecastMilestone(rows, pace, null, today);
    const got = (await featureForecasts(s.db, s.co, [f.id], today)).get(f.id)!;
    const { daysLate: _daysLate, ...withoutDaysLate } = expected;
    expect(got).not.toHaveProperty("daysLate");
    expect(got).toEqual(withoutDaysLate);
  });
});

describe("stampCardEnd", () => {
  const at = new Date("2026-11-27T10:00:00Z");

  it("writes the end onto a self_deploy card's context and keeps the other keys", async () => {
    const c = await s.card({ type: "self_deploy", notes: "keep me", nested: { a: 1 } });
    await stampCardEnd(s.db, c.id, { result: "cancelled", message: "cancelled before the host was told", by: "ceo" }, at);
    const [row] = await s.db.select().from(decisions).where(eq(decisions.id, c.id));
    expect(row!.context).toEqual({
      type: "self_deploy",
      notes: "keep me",
      nested: { a: 1 },
      result: { result: "cancelled", message: "cancelled before the host was told", by: "ceo", at: at.toISOString() },
    });
  });

  it("never overwrites a result the host already reported", async () => {
    const reported = { result: "succeeded", message: "host reported a clean finish", by: "host", at: "2026-11-26T09:00:00.000Z" };
    const c = await s.card({ type: "self_deploy", result: reported });
    await stampCardEnd(s.db, c.id, { result: "replaced", message: "a later guess" }, at);
    const [row] = await s.db.select().from(decisions).where(eq(decisions.id, c.id));
    expect(row!.context).toEqual({ type: "self_deploy", result: reported });
  });

  it("leaves a card of another context type alone", async () => {
    const c = await s.card({ type: "permission", command: "ls" });
    await stampCardEnd(s.db, c.id, { result: "cancelled", message: "not ours" }, at);
    const [row] = await s.db.select().from(decisions).where(eq(decisions.id, c.id));
    expect(row!.context).toEqual({ type: "permission", command: "ls" });
  });
});
