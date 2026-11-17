// BOS-1648 (R26 of BOS-1457): "is a runner update needed?" answers needed or not needed from the merges between the
// runner image's commit and the live commit and their touchesRunner; "can't tell" (with why) only when it truly can't,
// and then the CEO is woken once. The old line compared the two commits as strings and said "may still be needed".
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { RUNNER_NEED_UNKNOWN_REASON, runnerUpdateNeed, wakeCeoIfRunnerNeedUnknown } from "../src/services/runner-update-need.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
const COMPANY = "00000000-0000-4000-8000-000000000001";
let projectId: string;
const sha = (c: string) => c.repeat(40);
const [A, B, C, D, X] = ["a", "b", "c", "d", "e"].map(sha) as [string, string, string, string, string];

let n = 0;
/** A merged ticket, merged `min` minutes after a fixed start, so merge order is A, B, C, D. */
async function merge(commit: string, min: number, touchesRunner: boolean | null, number = 1600 + ++n) {
  await db.insert(tickets).values({ companyId: COMPANY, projectId, title: `T ${number}`, number, mergeCommit: commit, mergedAt: new Date(Date.UTC(2026, 10, 16, 10, min)), touchesRunner });
}
async function setLive(commit: string | null) {
  await db.delete(settings).where(eq(settings.key, `live_release:${COMPANY}`));
  if (commit) await db.insert(settings).values({ key: `live_release:${COMPANY}`, value: { old: commit, new: commit } });
}
async function setImage(commit: string | null) {
  await db.update(runners).set({ imageCommit: commit }).where(eq(runners.companyId, COMPANY));
}

beforeAll(async () => {
  ({ db, close } = await openPglite());
  await db.insert(companies).values({ id: COMPANY, name: "Home", ticketPrefix: "BOS", createdAt: new Date("2026-01-01T00:00:00Z") });
  projectId = (await db.insert(projects).values({ companyId: COMPANY, name: "Development" }).returning())[0]!.id;
});
afterAll(async () => close());
beforeEach(async () => {
  await db.delete(tickets);
  await db.delete(runners);
  await db.delete(settings);
  await db.delete(agents);
  n = 0;
});

describe("runnerUpdateNeed", () => {
  it("has nothing to say with no runner", async () => {
    await setLive(B);
    expect(await runnerUpdateNeed(db, COMPANY)).toBeNull();
  });

  describe("with a runner", () => {
    beforeEach(async () => {
      await db.insert(runners).values({ companyId: COMPANY, tokenHash: "x" });
      await merge(A, 0, true);
      await merge(B, 1, false, 1635);
      await merge(C, 2, true, 1583);
      await merge(D, 3, false, 1640);
    });

    it("16 Nov: only server code since the image (BOS-1635) → not needed, naming it", async () => {
      await setImage(A);
      await setLive(B);
      const need = await runnerUpdateNeed(db, COMPANY);
      expect(need).toMatchObject({ state: "not_needed", tickets: ["BOS-1635"] });
      expect(need!.words).toBe("Runners are up to date: the changes since they were built (BOS-1635) are server-only.");
    });

    it("a merge that changed what the runners are built from → needed, naming only that ticket", async () => {
      await setImage(A);
      await setLive(D);
      const need = await runnerUpdateNeed(db, COMPANY);
      expect(need).toMatchObject({ state: "needed", tickets: ["BOS-1583"] });
      expect(need!.words).toMatch(/^Runner update needed: BOS-1583 changes what the runners are built from/);
    });

    it("the image is the live commit, or a later one → not needed", async () => {
      await setImage(C);
      await setLive(C);
      expect((await runnerUpdateNeed(db, COMPANY))!.state).toBe("not_needed");
      await setLive(B);
      expect((await runnerUpdateNeed(db, COMPANY))!.state).toBe("not_needed");
    });

    it("live commit not recorded yet: the host's deployed commit stands in", async () => {
      await setImage(A);
      await setLive(null);
      expect((await runnerUpdateNeed(db, COMPANY, { liveFallback: D }))!.state).toBe("needed");
    });

    // BOS-1640's case: the live commit is no ticket's recorded merge. Never "not needed" by default.
    it("can't tell when the live commit can't be placed, with the reason and the fix", async () => {
      await setImage(A);
      await setLive(X);
      const need = await runnerUpdateNeed(db, COMPANY);
      expect(need!.state).toBe("unknown");
      expect(need!.words).toMatch(/^Boss Man can't tell whether a runner update is needed, because the server runs eeeeeeee, which isn't a merge Boss Man recorded/);
      expect(need!.words).not.toMatch(/\bmay\b|up to date/);
    });

    it("can't tell when the image never said its commit, or its commit can't be placed, or nothing is recorded as live", async () => {
      await setLive(B);
      await setImage(null);
      expect(await runnerUpdateNeed(db, COMPANY)).toMatchObject({ state: "unknown", key: "image-unrecorded" });
      await setImage(X);
      expect(await runnerUpdateNeed(db, COMPANY)).toMatchObject({ state: "unknown", key: `image-unplaced:${X}` });
      await setImage(A);
      await setLive(null);
      expect(await runnerUpdateNeed(db, COMPANY)).toMatchObject({ state: "unknown", key: "live-unrecorded" });
    });

    it("can't tell, not 'not needed', when a merge in between has no recorded file list", async () => {
      await db.update(tickets).set({ touchesRunner: null }).where(eq(tickets.mergeCommit, B));
      await setImage(A);
      await setLive(B);
      const need = await runnerUpdateNeed(db, COMPANY);
      expect(need!.state).toBe("unknown");
      expect(need!.words).toContain("BOS-1635");
      // A runner-touching merge still decides it: that one is known to be needed.
      await setLive(C);
      expect((await runnerUpdateNeed(db, COMPANY))!.state).toBe("needed");
    });
  });
});

describe("waking the CEO on can't tell", () => {
  it("wakes once per cause, again for a new cause, and forgets once the answer is known", async () => {
    const [ceo] = await db.insert(agents).values({ companyId: COMPANY, name: "CEO", role: "ceo", agentKind: "claude" }).returning();
    await db.insert(runners).values({ companyId: COMPANY, tokenHash: "x", imageCommit: A });
    await merge(A, 0, true);
    await merge(B, 1, false);
    const woken: { agentId: string; reason: string; note: string }[] = [];
    const wake = async (agentId: string, input: { reason: string; note: string }) => void woken.push({ agentId, ...input });
    const pass = async () => wakeCeoIfRunnerNeedUnknown(db, COMPANY, await runnerUpdateNeed(db, COMPANY), wake);

    await setLive(X);
    expect(await pass()).toBe(true);
    expect(await pass()).toBe(false);
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({ agentId: ceo!.id, reason: RUNNER_NEED_UNKNOWN_REASON });
    expect(woken[0]!.note).toContain("isn't a merge Boss Man recorded");

    await setLive(D); // another unplaced commit: a new cause
    expect(await pass()).toBe(true);
    await setLive(B); // known again
    expect(await pass()).toBe(false);
    await setLive(D); // the same cause coming back after it cleared wakes again
    expect(await pass()).toBe(true);
    expect(woken).toHaveLength(3);
  });

  it("a dropped wake is not remembered, so the next pass tries again", async () => {
    await db.insert(agents).values({ companyId: COMPANY, name: "CEO", role: "ceo", agentKind: "claude" });
    await db.insert(runners).values({ companyId: COMPANY, tokenHash: "x", imageCommit: A });
    await setLive(X);
    const need = await runnerUpdateNeed(db, COMPANY);
    expect(await wakeCeoIfRunnerNeedUnknown(db, COMPANY, need, async () => ({ status: "dropped" }))).toBe(false);
    expect(await wakeCeoIfRunnerNeedUnknown(db, COMPANY, need, async () => ({ status: "queued" }))).toBe(true);
  });
});
