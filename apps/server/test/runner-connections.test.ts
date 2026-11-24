import { afterEach, describe, expect, it, vi } from "vitest";
import { runnersService } from "../src/services/runners.js";
import { openPglite } from "../src/db/client.js";
import { companies, runnerConnections, runners } from "../src/db/schema.js";
import { closeConnection, closeOpenOnStart, connectionSummary, markStopped, openConnection, pruneConnections } from "../src/services/runner-connections.js";

const DAY = 86_400_000;
const NOW = new Date("2026-11-24T12:00:00Z");
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const opened = await openPglite();
  close = opened.close;
  const [co] = await opened.db.insert(companies).values({ name: "Co" }).returning({ id: companies.id });
  const [r] = await opened.db.insert(runners).values({ companyId: co!.id, tokenHash: "x" }).returning({ id: runners.id });
  return { db: opened.db, runnerId: r!.id };
}

describe("the runner hub", () => {
  it("writes a row when a runner connects and closes it when the socket goes", async () => {
    const { db, runnerId } = await setup();
    const hub = runnersService(db, null as never);
    const release = hub.connect(runnerId, () => true);
    await vi.waitFor(async () => expect(await db.select().from(runnerConnections)).toHaveLength(1));
    expect((await db.select().from(runnerConnections))[0]!.droppedAt).toBeNull();
    release();
    await vi.waitFor(async () => expect((await db.select().from(runnerConnections))[0]).toMatchObject({ endedHow: "dropped" }));
  });
});

describe("runner connection history", () => {
  it("has nothing to show before the first connection", async () => {
    const { db, runnerId } = await setup();
    expect((await connectionSummary(db, runnerId, NOW)).percentConnected).toBeNull();
  });

  it("counts drops, the share connected, the longest gap and lists only gaps of 30 s or more", async () => {
    const { db, runnerId } = await setup();
    // 10 h connected, 10 min gone, 10 h connected, 10 s gone, then connected to now.
    const a = await openConnection(db, runnerId, at(21 * 3_600_000 + 20 * 60_000));
    await closeConnection(db, a, at(11 * 3_600_000 + 20 * 60_000));
    const b = await openConnection(db, runnerId, at(11 * 3_600_000 + 10 * 60_000));
    await closeConnection(db, b, at(70_000));
    await openConnection(db, runnerId, at(60_000));
    const c = await openConnection(db, runnerId, at(1_000)); // supersedes the open one: a zero-length drop
    expect(c).toBeTruthy();
    const s = await connectionSummary(db, runnerId, NOW);
    expect(s.drops).toBe(3);
    expect(s.longestGapMs).toBe(10 * 60_000);
    expect(s.gaps.map((g) => g.ms)).toEqual([10 * 60_000]);
    expect(s.shortGaps).toBe(2);
    expect(s.percentConnected).toBeGreaterThan(97);
    expect(s.percentConnected).toBeLessThan(100);
  });

  it("shows a runner that is away now as an open gap", async () => {
    const { db, runnerId } = await setup();
    const a = await openConnection(db, runnerId, at(DAY));
    await closeConnection(db, a, at(5 * 60_000));
    const s = await connectionSummary(db, runnerId, NOW);
    expect(s.gaps[0]).toMatchObject({ to: null, ms: 5 * 60_000, how: "dropped" });
  });

  it("keeps a stop out of the drops and the longest gap", async () => {
    const { db, runnerId } = await setup();
    const a = await openConnection(db, runnerId, at(DAY));
    await closeConnection(db, a, at(2 * 3_600_000)); // the socket closes just after the stop
    await markStopped(db, runnerId, at(2 * 3_600_000 + 1_000));
    await openConnection(db, runnerId, at(3_600_000));
    const s = await connectionSummary(db, runnerId, NOW);
    expect(s.drops).toBe(0);
    expect(s.longestGapMs).toBe(0);
    expect(s.gaps[0]!.how).toBe("stopped");
  });

  it("ends rows left open by an earlier server process as a server restart, and leaves newer ones", async () => {
    const { db, runnerId } = await setup();
    await openConnection(db, runnerId, at(DAY));
    const started = at(60_000);
    await closeOpenOnStart(db, started);
    const rows = await db.select().from(runnerConnections);
    expect(rows[0]).toMatchObject({ endedHow: "server restart" });
    expect(rows[0]!.droppedAt!.getTime()).toBe(started.getTime());
    const fresh = await openConnection(db, runnerId, at(1_000));
    await closeOpenOnStart(db, started);
    expect((await db.select().from(runnerConnections)).find((r) => r.id === fresh)!.droppedAt).toBeNull();
  });

  it("removes rows older than 30 days", async () => {
    const { db, runnerId } = await setup();
    await closeConnection(db, await openConnection(db, runnerId, at(31 * DAY)), at(30 * DAY));
    await openConnection(db, runnerId, at(DAY));
    await pruneConnections(db, NOW);
    expect(await db.select().from(runnerConnections)).toHaveLength(1);
  });
});
