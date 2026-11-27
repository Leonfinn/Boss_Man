// BOS-2792: the two small helpers behind a ticket card's "Waiting for X's working hours" line and the
// sign-off card's facts (reviewers and verdicts, the last quick check, the builder). Neither had a test.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKING_HOURS_REASON } from "@boss-man/shared";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, reviewRequests, tickets, wakes } from "../src/db/schema.js";
import { signoffFacts } from "../src/services/signoff-facts.js";
import { workingHoursNotes } from "../src/services/working-hours-note.js";

let shared: Awaited<ReturnType<typeof openPglite>>;

beforeEach(async () => {
  shared = await openPglite();
});

afterEach(async () => {
  await shared.close();
});

let n = 0;
async function setup() {
  const { db } = shared;
  const [co] = await db.insert(companies).values({ name: `Co ${randomUUID()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const agent = async (name: string, patch: Partial<typeof agents.$inferInsert> = {}) =>
    (await db.insert(agents).values({ companyId: co!.id, name, role: "worker", agentKind: "claude", ...patch } as never).returning())[0]!;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, systemState: "review", ...patch } as never).returning())[0]!;
  const review = (ticketId: string, row: { round: number; seq: number; kind: string; status: string; reviewerAgentId?: string | null }) =>
    db.insert(reviewRequests).values({ ticketId, reviewerAgentId: null, ...row } as never).returning().then((r) => r[0]!);
  const job = (ticketId: string, row: { kind?: string; state: string; commit: string; endedAt?: Date | null }) =>
    db.insert(checkJobs).values({ companyId: co!.id, projectId: p!.id, ticketId, kind: "pre_review", scope: "quick", tree: `tree-${randomUUID()}`, ...row } as never).returning().then((r) => r[0]!);
  const wake = (agentId: string, row: { ticketId?: string | null; status?: string; statusReason?: string | null; notBefore?: Date | null }) =>
    db.insert(wakes).values({ companyId: co!.id, agentId, reason: "work", status: "deferred", statusReason: WORKING_HOURS_REASON, ...row } as never).returning().then((r) => r[0]!);
  return { db, companyId: co!.id, projectId: p!.id, agent, ticket, review, job, wake };
}

const HOURS = { days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00", timeZone: "UTC" };

describe("signoffFacts", () => {
  it("reads only the newest round, maps each status, names the reviewer or falls back, and skips an unknown status", async () => {
    const s = await setup();
    const rita = await s.agent("Rita");
    const basil = await s.agent("Basil");
    const t = await s.ticket({ assigneeAgentId: basil.id });

    await s.review(t.id, { round: 1, seq: 1, kind: "code", status: "changes_requested", reviewerAgentId: rita.id });
    await s.review(t.id, { round: 2, seq: 1, kind: "code", status: "approved", reviewerAgentId: rita.id });
    await s.review(t.id, { round: 2, seq: 2, kind: "security", status: "changes_requested", reviewerAgentId: null });
    await s.review(t.id, { round: 2, seq: 3, kind: "infra", status: "pending", reviewerAgentId: null });
    await s.review(t.id, { round: 2, seq: 4, kind: "adversarial", status: "overruled", reviewerAgentId: null });
    await s.review(t.id, { round: 2, seq: 5, kind: "spec", status: "skipped", reviewerAgentId: rita.id });

    const facts = await signoffFacts(s.db, t.id, 4);
    expect(facts.reviews).toEqual([
      { name: "Rita", kind: "code", verdict: "passed" },
      { name: "A reviewer", kind: "security", verdict: "changes" },
      { name: "A reviewer", kind: "infra", verdict: "waiting" },
      { name: "A reviewer", kind: "adversarial", verdict: "overruled" },
    ]);
    expect(facts.builder).toBe("Basil");
    expect(facts.files).toBe(4);
  });

  it("takes the newest ended pre-review job that passed or failed, ignoring other kinds and jobs still queued or running", async () => {
    const s = await setup();
    const t = await s.ticket();
    await s.job(t.id, { state: "passed", commit: "aaa", endedAt: new Date("2026-11-27T10:00:00Z") });
    await s.job(t.id, { state: "failed", commit: "bbb", endedAt: new Date("2026-11-27T11:00:00Z") });
    await s.job(t.id, { state: "queued", commit: "ccc", endedAt: null });
    await s.job(t.id, { kind: "merge", state: "passed", commit: "ddd", endedAt: new Date("2026-11-27T12:00:00Z") });
    await s.job(t.id, { state: "running", commit: "eee", endedAt: new Date("2026-11-27T13:00:00Z") });

    expect((await signoffFacts(s.db, t.id)).quickCheck).toEqual({ result: "failed", sha: "bbb", at: "2026-11-27T11:00:00.000Z" });
  });

  it("gives null quick check, null builder and null files when there is none of each", async () => {
    const s = await setup();
    const t = await s.ticket();

    expect(await signoffFacts(s.db, t.id)).toEqual({ reviews: [], quickCheck: null, files: null, builder: null });
  });
});

describe("workingHoursNotes", () => {
  it("gives an empty map for an empty list", async () => {
    const s = await setup();
    expect(await workingHoursNotes(s.db, [])).toEqual(new Map());
  });

  it("gives the waiting line for a ticket whose own wake is deferred for working hours", async () => {
    const s = await setup();
    const dylan = await s.agent("Dylan", { workingHours: HOURS });
    const t = await s.ticket({ assigneeAgentId: dylan.id });
    await s.wake(dylan.id, { ticketId: t.id, notBefore: new Date("2026-11-27T09:00:00Z") });

    const notes = await workingHoursNotes(s.db, [{ id: t.id, assigneeAgentId: dylan.id }], new Date("2026-11-27T08:00:00Z"));
    expect(notes.get(t.id)).toBe("Waiting for Dylan's working hours, from 09:00");
  });

  it("gives the line for another ticket held by an assignee who has the wake elsewhere", async () => {
    const s = await setup();
    const dylan = await s.agent("Dylan", { workingHours: HOURS });
    const first = await s.ticket({ assigneeAgentId: dylan.id });
    const second = await s.ticket({ assigneeAgentId: dylan.id });
    await s.wake(dylan.id, { ticketId: first.id, notBefore: new Date("2026-11-27T09:00:00Z") });

    const notes = await workingHoursNotes(s.db, [{ id: second.id, assigneeAgentId: dylan.id }], new Date("2026-11-27T08:00:00Z"));
    expect(notes.get(second.id)).toBe("Waiting for Dylan's working hours, from 09:00");
    expect(notes.size).toBe(1);
  });

  it("gives no line for a different reason, a wake that is not deferred, or an agent with no working hours", async () => {
    const s = await setup();
    const dylan = await s.agent("Dylan", { workingHours: HOURS });
    const other = await s.ticket({ assigneeAgentId: dylan.id });
    await s.wake(dylan.id, { ticketId: other.id, statusReason: "review requested", notBefore: new Date("2026-11-27T09:00:00Z") });
    const queued = await s.ticket({ assigneeAgentId: dylan.id });
    await s.wake(dylan.id, { ticketId: queued.id, status: "queued", notBefore: new Date("2026-11-27T09:00:00Z") });
    const noHours = await s.agent("Sam");
    const sams = await s.ticket({ assigneeAgentId: noHours.id });
    await s.wake(noHours.id, { ticketId: sams.id, notBefore: new Date("2026-11-27T09:00:00Z") });

    const now = new Date("2026-11-27T08:00:00Z");
    const notes = await workingHoursNotes(
      s.db,
      [
        { id: other.id, assigneeAgentId: dylan.id },
        { id: queued.id, assigneeAgentId: dylan.id },
        { id: sams.id, assigneeAgentId: noHours.id },
      ],
      now,
    );
    expect(notes.size).toBe(0);
  });
});
