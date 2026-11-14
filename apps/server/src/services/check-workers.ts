// Check workers (DR-060, BOS-1435): machines on any Docker host that take check jobs when the company runner's slots are
// full. A worker is a runner image started with BOSSMAN_ROLE=check-worker, with its own token and its own socket
// (/api/check-worker/connect) that carries check messages only. It is never a `runners` row: a runner holds secrets,
// merges and agent runs; a worker holds none of those.
//
// Rules the tests pin down:
//  - a worker gets a company's jobs only when it is on, connected, allowed for that company, announces "check-jobs" and
//    "check-bundle" (it can fetch the code itself, BOS-1436), and was built from the same commit as the company's runner
//    (DR-042: a check must mean the same thing wherever it runs). Otherwise it sits idle and says why, in plain words;
//  - its slot count is the owner's setting, lowered by what the worker itself reports; its slots are shared by every
//    company it serves.
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { CheckLimits, WorkerCommand } from "@boss-man/shared";
import { hashToken } from "../auth.js";
import type { Db } from "../db/client.js";
import { checkWorkers, companies, runners } from "../db/schema.js";
import { MAX_CHECK_SLOTS } from "./check-queue.js";

export type CheckWorker = typeof checkWorkers.$inferSelect;
export type WorkerSender = (command: WorkerCommand) => boolean;
/** The feature a worker announces once it can fetch a job's code itself (BOS-1436). Until then it never gets a job. */
export const BUNDLE_FEATURE = "check-bundle";
/** Close code for a worker socket replaced by a newer one with the same token (two machines sharing a token). */
export const WORKER_REPLACED_CLOSE = 4009;
/** Bounds for the per-check caps the owner sets per worker; the same as the protocol's CheckLimits. */
export const THREADS_MAX = 256;
export const MEMORY_MB_MIN = 256;
export const MEMORY_MB_MAX = 1_048_576;

export type WorkerSettings = { name: string; companyIds: string[]; slots: number; checkThreads: number | null; checkMemoryMb: number | null; enabled: boolean };
export type Eligible = { id: string; name: string; limit: number; limits?: CheckLimits };
export type Readiness = { ok: true; limit: number } | { ok: false; reason: string };

/** How many checks a worker may run at once: the owner's number, never more than the worker says it can run. */
export const workerLimit = (w: Pick<CheckWorker, "slots" | "reportedSlots">) => Math.max(1, Math.min(w.slots, w.reportedSlots ?? w.slots, MAX_CHECK_SLOTS));

const limitsOf = (w: Pick<CheckWorker, "checkThreads" | "checkMemoryMb">): CheckLimits | undefined =>
  w.checkThreads || w.checkMemoryMb ? { ...(w.checkThreads ? { threads: w.checkThreads } : {}), ...(w.checkMemoryMb ? { memoryMb: w.checkMemoryMb } : {}) } : undefined;

function validate(s: Partial<WorkerSettings>) {
  if (s.name !== undefined && !s.name.trim()) throw new Error("A check worker needs a name.");
  if (s.slots !== undefined && (!Number.isInteger(s.slots) || s.slots < 1 || s.slots > MAX_CHECK_SLOTS)) throw new Error(`Slots must be a whole number from 1 to ${MAX_CHECK_SLOTS}.`);
  if (s.checkThreads != null && (!Number.isInteger(s.checkThreads) || s.checkThreads < 1 || s.checkThreads > THREADS_MAX)) throw new Error(`Test threads must be a whole number from 1 to ${THREADS_MAX}.`);
  if (s.checkMemoryMb != null && (!Number.isInteger(s.checkMemoryMb) || s.checkMemoryMb < MEMORY_MB_MIN || s.checkMemoryMb > MEMORY_MB_MAX)) throw new Error(`Memory per check must be from ${MEMORY_MB_MIN} to ${MEMORY_MB_MAX} MB.`);
}

export function checkWorkersService(db: Db) {
  // shortcut: live sockets on this process (only the leader holds any); lost on restart, harmless because a worker redials, like a runner.
  const connected = new Map<string, { send: WorkerSender; close: (code: number, why: string) => void }>();
  // shortcut: per live socket; lost on restart, harmless because a worker sends its features again in hello.
  const features = new Map<string, string[]>();

  async function get(id: string): Promise<CheckWorker | null> {
    const [row] = await db.select().from(checkWorkers).where(eq(checkWorkers.id, id));
    return row ?? null;
  }

  /**
   * Whether this worker may take this company's checks now, or why not, in the owner's words. `runnerCommit` is the image
   * commit the company's runner last reported (null when unknown: then nothing can be compared, so nothing is sent).
   */
  /** Why this worker can take no company's checks at all (off, offline, an image that can't), or null. */
  function machineReason(w: CheckWorker): string | null {
    if (!w.enabled) return "Turned off.";
    if (!connected.has(w.id)) return w.lastSeenAt ? `Offline since ${w.lastSeenAt.toISOString()}.` : "Has not connected yet.";
    const feats = features.get(w.id) ?? [];
    if (!feats.includes("check-jobs")) return "Its image can't run queued checks: update this machine.";
    if (!feats.includes(BUNDLE_FEATURE)) return "Its image can't fetch the code to check yet (needs a newer image), so it gets no checks.";
    if (!w.imageCommit) return "It hasn't said which commit its image was built from: update this machine.";
    return null;
  }

  function readiness(w: CheckWorker, companyId: string, runnerCommit: string | null): Readiness {
    const why = machineReason(w);
    if (why) return { ok: false, reason: why };
    if (!w.companyIds.includes(companyId)) return { ok: false, reason: "Not set up for this company." };
    if (!runnerCommit) return { ok: false, reason: "The company's runner hasn't said which commit its image was built from, so results can't be compared." };
    if (w.imageCommit!.toLowerCase() !== runnerCommit.toLowerCase()) return { ok: false, reason: "Built from a different commit than the company's runner, so its results could differ: update this machine." };
    return { ok: true, limit: workerLimit(w) };
  }

  async function runnerCommit(companyId: string): Promise<string | null> {
    const [r] = await db.select({ c: runners.imageCommit }).from(runners).where(eq(runners.companyId, companyId));
    return r?.c ?? null;
  }

  return {
    /** Adds a worker and returns its token, which is shown once; only its hash is kept. */
    async register(s: WorkerSettings): Promise<{ worker: CheckWorker; token: string }> {
      validate(s);
      const token = `bmw_${randomBytes(32).toString("base64url")}`;
      const [worker] = await db
        .insert(checkWorkers)
        .values({ name: s.name.trim(), companyIds: [...new Set(s.companyIds)], slots: s.slots, checkThreads: s.checkThreads, checkMemoryMb: s.checkMemoryMb, enabled: s.enabled, tokenHash: hashToken(token) })
        .returning();
      return { worker: worker!, token };
    },

    /** The worker this token belongs to. A runner token (bmr_) never matches: its hash is only ever in `runners`. */
    async authenticate(token: string | undefined): Promise<CheckWorker | null> {
      if (!token) return null;
      const [row] = await db.select().from(checkWorkers).where(eq(checkWorkers.tokenHash, hashToken(token)));
      return row ?? null;
    },

    get,

    async update(id: string, s: Partial<WorkerSettings>): Promise<CheckWorker | null> {
      validate(s);
      const set = { ...s, ...(s.name !== undefined ? { name: s.name.trim() } : {}), ...(s.companyIds ? { companyIds: [...new Set(s.companyIds)] } : {}) };
      const [row] = await db.update(checkWorkers).set(set).where(eq(checkWorkers.id, id)).returning();
      return row ?? null;
    },

    /** Deletes the worker (its token stops working at once). The caller re-queues its jobs first. */
    async remove(id: string): Promise<boolean> {
      const gone = await db.delete(checkWorkers).where(eq(checkWorkers.id, id)).returning({ id: checkWorkers.id });
      return gone.length > 0;
    },

    /** Records a hello: last seen, image commit and version, the slots and features it reports. */
    async touch(id: string, hello: { imageCommit?: string; imageVersion: string | null; checkSlots?: number; features?: string[] }, now = new Date()): Promise<CheckWorker | null> {
      const [row] = await db
        .update(checkWorkers)
        .set({ lastSeenAt: now, imageCommit: hello.imageCommit ?? null, imageVersion: hello.imageVersion, reportedSlots: hello.checkSlots ?? null, features: hello.features ?? [] })
        .where(eq(checkWorkers.id, id))
        .returning();
      return row ?? null;
    },

    async seen(id: string, now = new Date()) {
      await db.update(checkWorkers).set({ lastSeenAt: now }).where(eq(checkWorkers.id, id));
    },

    connect(id: string, send: WorkerSender, close: (code: number, why: string) => void, feats: string[] = []) {
      const entry = { send, close };
      // Two machines sharing one token: the newer socket wins and the older one is closed, so it can't run on unseen.
      // Its jobs are re-synced by the newer machine's hello; if it redials, each hello cancels the other's leftovers.
      const prev = connected.get(id);
      connected.set(id, entry);
      if (prev) prev.close(WORKER_REPLACED_CLOSE, "replaced by a newer connection");
      features.set(id, feats);
      return () => {
        if (connected.get(id) === entry) {
          connected.delete(id);
          features.delete(id);
        }
      };
    },

    /** Closes a worker's open socket (turned off or removed). */
    disconnect(id: string, code: number, why: string) {
      connected.get(id)?.close(code, why);
    },

    send: (id: string, command: WorkerCommand): boolean => connected.get(id)?.send(command) ?? false,
    isConnected: (id: string) => connected.has(id),

    readiness,

    /** The workers that may take this company's checks now, oldest first, with their slot limit and per-check caps. */
    async eligible(companyId: string): Promise<Eligible[]> {
      // Cheap when there are no workers (the common case): one indexed read, nothing else.
      const all = await db.select().from(checkWorkers).where(eq(checkWorkers.enabled, true)).orderBy(asc(checkWorkers.createdAt));
      if (!all.length) return [];
      const commit = await runnerCommit(companyId);
      const out: Eligible[] = [];
      for (const w of all) {
        const r = readiness(w, companyId, commit);
        if (r.ok) out.push({ id: w.id, name: w.name, limit: r.limit, limits: limitsOf(w) });
      }
      return out;
    },

    /** Every worker for the Settings panel: settings, what it last reported, and per allowed company whether it takes checks and why not. */
    async list() {
      const all = await db.select().from(checkWorkers).orderBy(asc(checkWorkers.createdAt));
      const names = new Map((await db.select({ id: companies.id, name: companies.name }).from(companies)).map((c) => [c.id, c.name]));
      const commits = new Map((await db.select({ c: runners.companyId, commit: runners.imageCommit }).from(runners)).map((r) => [r.c, r.commit]));
      return all.map((w) => ({
        id: w.id,
        name: w.name,
        enabled: w.enabled,
        connected: connected.has(w.id),
        slots: w.slots,
        reportedSlots: w.reportedSlots,
        limit: workerLimit(w),
        checkThreads: w.checkThreads,
        checkMemoryMb: w.checkMemoryMb,
        imageCommit: w.imageCommit,
        imageVersion: w.imageVersion,
        lastSeenAt: w.lastSeenAt,
        createdAt: w.createdAt,
        companies: w.companyIds.map((id) => {
          const r = readiness(w, id, commits.get(id) ?? null);
          return { id, name: names.get(id) ?? "(deleted company)", ready: r.ok, reason: r.ok ? null : r.reason };
        }),
        // One line when nothing works for any company (turned off, offline, old image); null otherwise.
        reason: machineReason(w),
      }));
    },

    /** Names of workers by id, for "where it ran". */
    async names(): Promise<Map<string, string>> {
      return new Map((await db.select({ id: checkWorkers.id, name: checkWorkers.name }).from(checkWorkers)).map((w) => [w.id, w.name]));
    },
  };
}

export type CheckWorkersService = ReturnType<typeof checkWorkersService>;
