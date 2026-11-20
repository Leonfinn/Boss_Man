// BOS-2089: a runner restart left the repo lock folder of the process it killed, and every repo operation (diffs for
// merges, agents' work copies) then timed out for 10 minutes, longer than the merge's restart retries. The lock is now a
// lease: its holder touches it, and one nobody touches is taken over.
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoLockTimeout, setRepoLockTiming, Workspaces } from "../src/workspace.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
type Locking = { withRepoLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> };
const locking = (ws: Workspaces) => ws as unknown as Locking;
const lockDir = (root: string) => path.join(root, "repos", `${PROJECT}.lock`);
const ago = (ms: number) => new Date(Date.now() - ms);

afterEach(() => setRepoLockTiming({ beatMs: 5_000, staleMs: 45_000, waitMs: 60_000 }));

describe("repo lock lease (BOS-2089)", () => {
  it("takes over a lock whose holder died: its lease went untouched (the 20 Nov runner restart)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-lock-"));
    // What the killed runner left: a fresh lock folder (made seconds before the kill) with a lease nobody renews.
    mkdirSync(lockDir(root), { recursive: true });
    writeFileSync(path.join(lockDir(root), "lease"), "");
    utimesSync(path.join(lockDir(root), "lease"), ago(60_000), ago(60_000));
    // A short wait: the old code (10 minutes by the folder's age) times out here; the lease rule takes the lock at once.
    setRepoLockTiming({ waitMs: 2_000 });
    await expect(locking(new Workspaces(root)).withRepoLock(PROJECT, async () => "ran")).resolves.toBe("ran");
  });

  it("never takes a lock from a live holder in another process, however long it holds it", async () => {
    setRepoLockTiming({ beatMs: 50, staleMs: 400, waitMs: 10_000 });
    const root = mkdtempSync(path.join(tmpdir(), "bm-lock-"));
    // Two Workspaces share nothing in memory, like the runner and a check worker on one disk.
    const holder = new Workspaces(root);
    const other = new Workspaces(root);
    const order: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const isHeld = new Promise<void>((r) => (started = r));
    const held = locking(holder).withRepoLock(PROJECT, async () => {
      order.push("holder in");
      started();
      // Held for several lease lengths: only the holder's beat keeps it from looking dead.
      await new Promise<void>((r) => (release = r));
      order.push("holder out");
    });
    await isHeld;
    const waiting = locking(other).withRepoLock(PROJECT, async () => void order.push("other in"));
    // Wait for the lease to have been renewed past its stale age at least twice before letting go.
    const lease = path.join(lockDir(root), "lease");
    const firstBeat = statSync(lease).mtimeMs;
    for (let i = 0; i < 400 && statSync(lease).mtimeMs - firstBeat < 1_000; i++) await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["holder in"]);
    release();
    await Promise.all([held, waiting]);
    expect(order).toEqual(["holder in", "holder out", "other in"]);
  });

  it("keeps the 10-minute rule for a lock with no lease (a holder still on the old code)", async () => {
    setRepoLockTiming({ staleMs: 100, waitMs: 500 });
    const root = mkdtempSync(path.join(tmpdir(), "bm-lock-"));
    mkdirSync(lockDir(root), { recursive: true });
    utimesSync(lockDir(root), ago(5 * 60_000), ago(5 * 60_000));
    await expect(locking(new Workspaces(root)).withRepoLock(PROJECT, async () => "ran")).rejects.toBeInstanceOf(RepoLockTimeout);
    utimesSync(lockDir(root), ago(11 * 60_000), ago(11 * 60_000));
    await expect(locking(new Workspaces(root)).withRepoLock(PROJECT, async () => "ran")).resolves.toBe("ran");
  });
});
