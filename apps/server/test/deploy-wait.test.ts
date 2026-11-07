// BOS-420: an approved server update waits for a quiet machine, holds work back softly while it waits and
// through the standby window, asks the owner once per deadline, and survives a restart.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import type { Db } from "../src/db/client.js";
import { companies, decisions, settings } from "../src/db/schema.js";
import { CANCEL_UPDATE, KEEP_WAITING_MORE, UPDATE_NOW_ANYWAY } from "../src/services/decisions.js";
import { DEPLOY_WAIT_KEY, deployWaitService, type DeployWaitDeps } from "../src/services/deploy-wait.js";
import { selfDeployService, type DeployStatus, type Headroom } from "../src/services/self-deploy.js";

const MIN = 60_000;
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const ID = "11111111-1111-4111-8111-111111111111";

let db: Db;
let close: () => Promise<void>;
let t0: number;
let offset: number;
const clock = () => new Date(t0 + offset);

/** A world the service reads: the host's memory report, checks, runs, the host's status and what it offers. */
function world() {
  const w = {
    headroom: { version: 1, writtenAt: "", availableMb: 8000, needMb: 4096 } as Headroom | null,
    headroomAgeMs: 10_000,
    checks: 0,
    runs: 0,
    status: null as DeployStatus | null,
    tip: B,
    deployed: A,
    trialUntil: null as string | null,
    runnerCard: false,
    drain: false,
    inbox: null as { id: string; override: boolean } | null,
    sent: [] as { id: string; override: boolean }[],
    notes: [] as { level: string; title: string }[],
    released: 0,
    sendFails: false,
  };
  const deps: DeployWaitDeps = {
    headroom: async () => (w.headroom ? { ...w.headroom, writtenAt: new Date(clock().getTime() - w.headroomAgeMs).toISOString() } : null),
    checksRunning: async () => w.checks,
    openRuns: async () => w.runs,
    send: async (_ctx, id, opts) => {
      if (w.sendFails) throw new Error("disk full");
      w.sent.push({ id, override: !!opts.override });
      w.inbox = { id, override: !!opts.override };
    },
    takeBack: async (id) => {
      if (w.inbox?.id !== id) return false;
      w.inbox = null;
      return true;
    },
    status: async () => w.status,
    available: async () => ({ checkedAt: "", deployed: w.deployed, tip: w.tip, commits: [], paths: [], infraPaths: [], runnerChanged: false }),
    trialUntil: async () => w.trialUntil,
    runnerCardOpen: async () => w.runnerCard,
    drainOn: async () => w.drain,
    notify: async (n) => void w.notes.push({ level: n.level, title: n.title }),
    released: () => void w.released++,
    now: clock,
  };
  /** The host takes the request and reports how it went. */
  const host = (result: DeployStatus["result"]) => {
    w.inbox = null;
    w.status = { id: ID, target: "server", result, message: result, from_commit: A, to_commit: B, started: clock().toISOString(), ended: result === "running" ? "" : clock().toISOString(), backup: "" };
  };
  return { w, deps, host };
}

const cards = () => db.select().from(decisions).where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'deploy_wait'`));

beforeEach(async () => {
  ({ db, close } = await openPglite());
  await db.insert(companies).values({ name: "Home" });
  t0 = Date.parse("2026-11-07T10:00:00Z");
  offset = 0;
});
afterEach(async () => close());

describe("deploy wait (BOS-420)", () => {
  it("a quiet machine never waits: the request goes at once", async () => {
    const { w, deps } = world();
    const svc = deployWaitService(db, deps);
    const r = await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    expect(r.phase).toBe("sent");
    expect(w.sent).toEqual([{ id: ID, override: false }]);
    expect(w.notes).toEqual([]);
  });

  it("waits while a merge check runs or memory is short, and sends when both clear", async () => {
    const { w, deps } = world();
    w.checks = 2;
    w.headroom = { version: 1, writtenAt: "", availableMb: 2048, needMb: 4096 };
    const svc = deployWaitService(db, deps);
    const r = await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    expect(r.phase).toBe("waiting");
    expect(r.quiet?.why.join("; ")).toMatch(/2 merge checks are running/);
    expect(r.quiet?.why.join("; ")).toMatch(/2\.0 GB of memory is free and the update needs 4\.0 GB/);
    expect(w.sent).toEqual([]);
    expect(w.notes[0]?.title).toMatch(/waiting for a quiet machine/);
    expect((await svc.softHold()).on).toBe(true);

    w.checks = 0;
    offset += 15_000;
    expect((await svc.step())?.phase).toBe("waiting"); // memory still short
    w.headroom = { version: 1, writtenAt: "", availableMb: 6000, needMb: 4096 };
    offset += 15_000;
    expect((await svc.step())?.phase).toBe("sent");
    expect(w.sent).toEqual([{ id: ID, override: false }]);
  });

  it("too many runs is not quiet; the cap is the same number", async () => {
    const { w, deps } = world();
    w.runs = 5;
    const svc = deployWaitService(db, deps);
    expect((await svc.begin({ decisionId: ID, commit: B, fromCommit: A })).phase).toBe("waiting");
    expect(await svc.softHold()).toEqual({ on: true, phase: "waiting", maxRuns: 3 });
    w.runs = 3;
    expect((await svc.step())?.phase).toBe("sent");
  });

  it("a stale host report counts as not quiet; a missing one (older deployer) skips only the memory test", async () => {
    const { w, deps } = world();
    w.headroomAgeMs = 10 * MIN;
    const svc = deployWaitService(db, deps);
    const r = await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    expect(r.phase).toBe("waiting");
    expect(r.quiet?.why[0]).toMatch(/hasn't reported for 10 min/);
    w.headroom = null;
    const s = await svc.step();
    expect(s?.phase).toBe("sent");
    expect((await svc.get())?.quiet?.memoryUnknown).toBe(true);
  });

  it("after 30 minutes the owner gets one card, and a restart neither resets the wait nor asks twice", async () => {
    const { w, deps } = world();
    w.checks = 1;
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    offset += 29 * MIN;
    await svc.step();
    expect(await cards()).toHaveLength(0);
    offset += 2 * MIN;
    await svc.step();
    await svc.step();
    const [card] = await cards();
    expect(card?.options).toEqual([KEEP_WAITING_MORE(30), UPDATE_NOW_ANYWAY, CANCEL_UPDATE]);
    expect(card?.question).toMatch(/1 merge check is running/);
    // A restart: a new service on the same database keeps the wait and its deadline, and raises no second card.
    const again = deployWaitService(db, deps);
    const kept = await again.get();
    expect(kept?.phase).toBe("waiting");
    expect(kept?.deadline).toBe(new Date(t0 + 30 * MIN).toISOString());
    await again.step();
    expect(await cards()).toHaveLength(1);
  });

  it("keep waiting moves the deadline on and earns a new card at the next one", async () => {
    const { w, deps } = world();
    w.checks = 1;
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    offset += 31 * MIN;
    await svc.step();
    await svc.answered(KEEP_WAITING_MORE(30));
    await db.update(decisions).set({ status: "answered" }).where(sql`${decisions.context}->>'type' = 'deploy_wait'`);
    expect((await svc.get())?.deadline).toBe(new Date(t0 + 61 * MIN).toISOString());
    offset += 10 * MIN;
    await svc.step();
    expect(await cards()).toHaveLength(0);
    offset += 25 * MIN;
    await svc.step();
    expect(await cards()).toHaveLength(1);
  });

  it("update now anyway sends with the override, past the host's memory floor", async () => {
    const { w, deps } = world();
    w.headroom = { version: 1, writtenAt: "", availableMb: 1000, needMb: 4096 };
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    await svc.answered(UPDATE_NOW_ANYWAY);
    expect(w.sent).toEqual([{ id: ID, override: true }]);
    expect((await svc.get())?.phase).toBe("sent");
  });

  it("a request the host holds for memory is asked about after 30 minutes, and update now swaps it for an override", async () => {
    const { w, deps } = world();
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    w.headroom = { version: 1, writtenAt: "", availableMb: 1000, needMb: 4096, holding: "low memory" };
    offset += 31 * MIN;
    await svc.step();
    const [card] = await cards();
    expect(card?.question).toMatch(/holding it because memory is short/);
    await svc.answered(UPDATE_NOW_ANYWAY);
    expect(w.sent).toEqual([{ id: ID, override: false }, { id: ID, override: true }]);
    expect(w.inbox).toEqual({ id: ID, override: true });
  });

  it("update now never sends twice once the host has taken the request", async () => {
    const { w, deps, host } = world();
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    host("running");
    await svc.answered(UPDATE_NOW_ANYWAY);
    expect(w.sent).toHaveLength(1);
  });

  it("cancel ends the wait and takes back our own request; once the host has it, it is too late", async () => {
    const { w, deps, host } = world();
    w.checks = 1;
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    expect(await svc.cancel()).toEqual({ cancelled: true });
    expect(await svc.get()).toBeNull();
    expect(w.released).toBe(1);
    expect(w.notes.at(-1)?.title).toMatch(/cancelled/);

    w.checks = 0;
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A }); // quiet: sent at once
    expect(await svc.cancel()).toEqual({ cancelled: true });
    expect(w.inbox).toBeNull(); // taken back before the host saw it

    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    host("running");
    expect(await svc.cancel()).toEqual({ cancelled: false, tooLate: true });
    expect((await svc.get())?.phase).toBe("sent");
  });

  it("holds through the standby window, hands over to the runner drain, then lifts", async () => {
    const { w, deps, host } = world();
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    host("running");
    expect((await svc.step())?.phase).toBe("sent");
    host("deployed");
    w.trialUntil = new Date(t0 + 17 * MIN).toISOString();
    expect((await svc.step())?.phase).toBe("window");
    expect((await svc.softHold()).on).toBe(true);
    offset += 10 * MIN;
    expect((await svc.step())?.phase).toBe("window");
    offset += 8 * MIN;
    w.runnerCard = true; // the release changed runner files: the runner update is offered
    expect((await svc.step())?.phase).toBe("handover");
    expect((await svc.softHold()).on).toBe(true);
    w.drain = true; // the owner said Update runners: the full hold takes over
    expect(await svc.step()).toBeNull();
    expect((await svc.softHold()).on).toBe(false);
    expect(w.released).toBe(1);
  });

  it("without runner changes the hold lifts when the window ends; a single server (no window) lifts on deployed", async () => {
    const { w, deps, host } = world();
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    host("deployed");
    w.trialUntil = new Date(t0 + 17 * MIN).toISOString();
    await svc.step();
    offset += 18 * MIN;
    expect(await svc.step()).toBeNull();

    w.status = null;
    w.trialUntil = null;
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    host("deployed");
    expect(await svc.step()).toBeNull();
  });

  it("a handover the owner puts off lifts after 30 minutes at the most", async () => {
    const { w, deps, host } = world();
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    host("deployed");
    w.trialUntil = new Date(t0 + MIN).toISOString();
    await svc.step();
    offset += 2 * MIN;
    w.runnerCard = true;
    expect((await svc.step())?.phase).toBe("handover");
    offset += 29 * MIN;
    expect((await svc.step())?.phase).toBe("handover");
    offset += 2 * MIN;
    expect(await svc.step()).toBeNull();
  });

  it("a switch-back or a refusal ends the wait without a second notification", async () => {
    const { w, deps, host } = world();
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    host("deployed");
    w.trialUntil = new Date(t0 + 17 * MIN).toISOString();
    await svc.step();
    host("rolled_back");
    expect(await svc.step()).toBeNull();
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    host("rejected");
    expect(await svc.step()).toBeNull();
    expect(w.notes).toEqual([]); // self-deploy reports how a deploy ended
  });

  it("main moving on while it waits makes the approval lapse", async () => {
    const { w, deps } = world();
    w.checks = 1;
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    w.tip = C;
    expect(await svc.step()).toBeNull();
    expect(w.sent).toEqual([]);
    expect(w.notes.at(-1)?.title).toMatch(/main moved on/);
  });

  it("the soft hold lifts itself after 3 hours with a page", async () => {
    const { w, deps } = world();
    w.checks = 1;
    const svc = deployWaitService(db, deps);
    await svc.begin({ decisionId: ID, commit: B, fromCommit: A });
    offset += 3 * 60 * MIN + 1;
    expect((await svc.softHold()).on).toBe(false); // even before the pass runs
    expect(await svc.step()).toBeNull();
    expect(w.notes.at(-1)).toEqual({ level: "page", title: "Update wait stopped after 3 hours" });
    expect(w.sent).toEqual([]);
    const [row] = await db.select().from(settings).where(eq(settings.key, DEPLOY_WAIT_KEY));
    expect(row).toBeUndefined();
  });

  it("a failed send leaves no wait behind, so the approval can be tried again", async () => {
    const { w, deps } = world();
    w.sendFails = true;
    const svc = deployWaitService(db, deps);
    await expect(svc.begin({ decisionId: ID, commit: B, fromCommit: A })).rejects.toThrow(/disk full/);
    expect(await svc.get()).toBeNull();
  });

  it("self-deploy writes the override for the host, takes back only its own request, and reads the host's memory report", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bm-wait-"));
    try {
      await mkdir(path.join(dir, "inbox"));
      await mkdir(path.join(dir, "outbox"));
      const sd = selfDeployService(db, { dir, notify: async () => {} });
      const req = path.join(dir, "inbox", "request.json");
      await sd.send({ target: "server", commit: B }, ID);
      expect(JSON.parse(await readFile(req, "utf8"))).not.toHaveProperty("quiet");
      await sd.send({ target: "server", commit: B }, ID, { override: true });
      expect(JSON.parse(await readFile(req, "utf8")).quiet).toBe("override");
      expect(await sd.takeBack("22222222-2222-4222-8222-222222222222")).toBe(false); // not ours: left alone
      expect(await sd.takeBack(ID)).toBe(true);
      expect(await sd.takeBack(ID)).toBe(false);
      expect(await sd.headroom()).toBeNull(); // an older deployer
      // What scripts/host-deployer.sh writes (its test pins the same shape).
      await writeFile(path.join(dir, "outbox", "headroom.json"), `{"version": 1, "writtenAt": "2026-11-07T10:00:00Z", "totalMb": 32768, "availableMb": 2048, "swapTotalMb": 2048, "swapUsedMb": 1024, "needMb": 4096, "needFrom": "build", "holding": "low memory", "lastUpdate": {"commit": "${B}", "lowMb": 2048, "lowAt": "before-build", "swapPeakMb": 1024}}\n`);
      expect(await sd.headroom()).toMatchObject({ availableMb: 2048, needMb: 4096, holding: "low memory", lastUpdate: { lowAt: "before-build" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a hand-applied update never sends; the hold runs until the host reports the new commit, then through the window", async () => {
    const { w, deps } = world();
    w.checks = 1;
    const svc = deployWaitService(db, deps);
    const r = await svc.begin({ decisionId: ID, commit: B, fromCommit: A, origin: "hand" });
    expect(r.phase).toBe("waiting");
    w.checks = 0;
    expect((await svc.step())?.quiet?.ready).toBe(true);
    expect(w.sent).toEqual([]);
    w.deployed = B;
    w.trialUntil = new Date(t0 + 17 * MIN).toISOString();
    expect((await svc.step())?.phase).toBe("window");
  });
});
