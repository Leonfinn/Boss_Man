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
import { PROTOCOL_VERSION, toolchainDifferences, type CheckLimits, type WorkerCommand } from "@boss-man/shared";
import { hashToken } from "../auth.js";
import type { Db } from "../db/client.js";
import { checkWorkers, companies, runners } from "../db/schema.js";
import { MACHINE_TAKES, MAX_CHECK_SLOTS, readPolicy, type MachineTakes, type SlotPolicy } from "./check-queue.js";

type Tc = { fingerprint: string; tools: Record<string, string> };

/** Ids of workers with an open socket on this process, for the owner's-setup record (BOS-1596); mirrors each service's `connected` map. */
// shortcut: this process only (the leader holds the sockets); lost on restart, harmless because a worker redials.
const liveWorkerIds = new Set<string>();
export const onlineWorkerCount = () => liveWorkerIds.size;

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

/** `takes` and `mergeKept` (BOS-1602) are optional: left out, a new worker takes both kinds with no slot kept, as before. */
export type WorkerSettings = { name: string; companyIds: string[]; slots: number; checkThreads: number | null; checkMemoryMb: number | null; enabled: boolean; takes?: MachineTakes; mergeKept?: number };
export type Eligible = { id: string; name: string; limit: number; limits?: CheckLimits; policy?: SlotPolicy };

/** BOS-1602: the worker's split as the queue reads it. */
export const workerPolicy = (w: Pick<CheckWorker, "takes" | "mergeKept">): SlotPolicy => readPolicy({ takes: w.takes, mergeKept: w.mergeKept });
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
  if (s.takes !== undefined && !MACHINE_TAKES.includes(s.takes)) throw new Error("Takes must be merges and quick checks, merges only, or quick checks only.");
  if (s.mergeKept !== undefined && (!Number.isInteger(s.mergeKept) || s.mergeKept < 0 || s.mergeKept > MAX_CHECK_SLOTS)) throw new Error(`Kept for merges must be a whole number from 0 to ${MAX_CHECK_SLOTS}.`);
}

/** Kept slots only mean something when the machine takes both kinds; stored as 0 otherwise, so the panel never shows a stale number. */
const keptFor = (takes: MachineTakes | undefined, kept: number | undefined) => (takes !== undefined && takes !== "both" ? 0 : kept);

export function checkWorkersService(db: Db) {
  // shortcut: live sockets on this process (only the leader holds any); lost on restart, harmless because a worker redials, like a runner.
  const connected = new Map<string, { send: WorkerSender; close: (code: number, why: string) => void }>();
  // BOS-1570: a worker whose code speaks another protocol is refused at hello and never "connects"; remember what it said so
  // the panel can show "worker code too old" instead of a bare "Offline".
  // shortcut: one entry per worker id, this process only; lost on restart, harmless because the worker redials within seconds and is refused again.
  const refused = new Map<string, { protocol: number; at: Date }>();
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
    const bad = refused.get(w.id);
    if (!connected.has(w.id) && bad && Date.now() - bad.at.getTime() < 10 * 60_000) {
      return `Out of date: worker code too old (it speaks protocol ${bad.protocol}, your server needs ${PROTOCOL_VERSION}). Redeploy this worker so it rebuilds from the current source; no file edit is needed.`;
    }
    if (!connected.has(w.id)) return w.lastSeenAt ? `Offline since ${w.lastSeenAt.toISOString()}.` : "Has not connected yet. If its log says \"Can't find the address\" (ENOTFOUND), that machine can't look up the address in its file: if it is a Tailscale name, the machine isn't on your tailnet, so put Boss Man's local network address in BOSSMAN_URL and redeploy it.";
    const feats = features.get(w.id) ?? [];
    if (!feats.includes("check-jobs")) return "Its image can't run queued checks: update this machine.";
    if (!feats.includes(BUNDLE_FEATURE)) return "Its image can't fetch the code to check yet (needs a newer image), so it gets no checks.";
    if (!w.imageCommit && !w.toolchain) return "It hasn't said which tools or commit its image was built with: update this machine.";
    return null;
  }

  /**
   * BOS-1570: a worker matches on the tools checks run with (Node, pnpm, git, ...), not on the commit its image was built
   * from, so a runner update that leaves the tools alone leaves the worker working. The commit stays the test only
   * when one side's image is too old to report its tools.
   */
  function readiness(w: CheckWorker, companyId: string, runnerCommit: string | null, runnerToolchain: Tc | null = null): Readiness {
    const why = machineReason(w);
    if (why) return { ok: false, reason: why };
    if (!w.companyIds.includes(companyId)) return { ok: false, reason: "Not set up for this company." };
    if (w.toolchain && runnerToolchain) {
      if (w.toolchain.fingerprint === runnerToolchain.fingerprint) return { ok: true, limit: workerLimit(w) };
      const diff = toolchainDifferences(w.toolchain.tools, runnerToolchain.tools);
      return { ok: false, reason: `Out of date: its tools differ from your runner's (${diff.length ? diff.join("; ") : "see the tool list"}). Redeploy this worker so it rebuilds; no file edit is needed.` };
    }
    // One side can't report its tools: fall back to the commit.
    if (!runnerCommit) return { ok: false, reason: "The company's runner hasn't said which tools or commit its image was built with, so results can't be compared." };
    if (!w.imageCommit) return { ok: false, reason: "Its image is too old to report its tools and has no commit: update this machine." };
    if (w.imageCommit.toLowerCase() !== runnerCommit.toLowerCase()) {
      return { ok: false, reason: w.toolchain ? "Your runner's image is older and can't report its tools, and the commits differ: rebuild the runner (Build and update runners)." : "Its image is older than this check and can't report its tools, and its commit differs from your runner's: redeploy this worker from the current compose.yaml (one time only)." };
    }
    return { ok: true, limit: workerLimit(w) };
  }

  async function runnerImage(companyId: string): Promise<{ commit: string | null; toolchain: Tc | null }> {
    const [r] = await db.select({ c: runners.imageCommit, t: runners.toolchain }).from(runners).where(eq(runners.companyId, companyId));
    return { commit: r?.c ?? null, toolchain: r?.t ?? null };
  }

  return {
    /** Adds a worker and returns its token, which is shown once; only its hash is kept. */
    async register(s: WorkerSettings): Promise<{ worker: CheckWorker; token: string }> {
      validate(s);
      const token = `bmw_${randomBytes(32).toString("base64url")}`;
      const [worker] = await db
        .insert(checkWorkers)
        .values({ name: s.name.trim(), companyIds: [...new Set(s.companyIds)], slots: s.slots, checkThreads: s.checkThreads, checkMemoryMb: s.checkMemoryMb, enabled: s.enabled, takes: s.takes ?? "both", mergeKept: keptFor(s.takes, s.mergeKept) ?? 0, tokenHash: hashToken(token) })
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

    /** A hello with a protocol this server doesn't speak was refused: keep it so the owner is told why (BOS-1570). */
    refuse(id: string, protocol: number, now = new Date()) {
      refused.set(id, { protocol, at: now });
    },

    async update(id: string, s: Partial<WorkerSettings>): Promise<CheckWorker | null> {
      validate(s);
      const kept = keptFor(s.takes, s.mergeKept);
      const set = { ...s, ...(s.name !== undefined ? { name: s.name.trim() } : {}), ...(s.companyIds ? { companyIds: [...new Set(s.companyIds)] } : {}), ...(kept !== undefined ? { mergeKept: kept } : {}) };
      const [row] = await db.update(checkWorkers).set(set).where(eq(checkWorkers.id, id)).returning();
      return row ?? null;
    },

    /** Deletes the worker (its token stops working at once). The caller re-queues its jobs first. */
    async remove(id: string): Promise<boolean> {
      const gone = await db.delete(checkWorkers).where(eq(checkWorkers.id, id)).returning({ id: checkWorkers.id });
      return gone.length > 0;
    },

    /** Records a hello: last seen, image commit and version, the slots and features it reports. */
    async touch(id: string, hello: { imageCommit?: string; toolchain?: { fingerprint: string; tools: Record<string, string> }; imageVersion: string | null; checkSlots?: number; features?: string[] }, now = new Date()): Promise<CheckWorker | null> {
      const [row] = await db
        .update(checkWorkers)
        .set({ lastSeenAt: now, imageCommit: hello.imageCommit ?? null, toolchain: hello.toolchain ?? null, imageVersion: hello.imageVersion, reportedSlots: hello.checkSlots ?? null, features: hello.features ?? [] })
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
      liveWorkerIds.add(id);
      if (prev) prev.close(WORKER_REPLACED_CLOSE, "replaced by a newer connection");
      features.set(id, feats);
      return () => {
        if (connected.get(id) === entry) {
          connected.delete(id);
          liveWorkerIds.delete(id);
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
      const image = await runnerImage(companyId);
      const out: Eligible[] = [];
      for (const w of all) {
        const r = readiness(w, companyId, image.commit, image.toolchain);
        if (r.ok) out.push({ id: w.id, name: w.name, limit: r.limit, limits: limitsOf(w), policy: workerPolicy(w) });
      }
      return out;
    },

    /** Every worker for the Settings panel: settings, what it last reported, and per allowed company whether it takes checks and why not. */
    async list() {
      const all = await db.select().from(checkWorkers).orderBy(asc(checkWorkers.createdAt));
      const names = new Map((await db.select({ id: companies.id, name: companies.name }).from(companies)).map((c) => [c.id, c.name]));
      const images = new Map((await db.select({ c: runners.companyId, commit: runners.imageCommit, tc: runners.toolchain }).from(runners)).map((r) => [r.c, r]));
      return all.map((w) => ({
        id: w.id,
        name: w.name,
        enabled: w.enabled,
        connected: connected.has(w.id),
        slots: w.slots,
        reportedSlots: w.reportedSlots,
        limit: workerLimit(w),
        takes: workerPolicy(w).takes,
        mergeKept: workerPolicy(w).mergeKept,
        checkThreads: w.checkThreads,
        checkMemoryMb: w.checkMemoryMb,
        imageCommit: w.imageCommit,
        toolchain: w.toolchain?.tools ?? null,
        imageVersion: w.imageVersion,
        lastSeenAt: w.lastSeenAt,
        createdAt: w.createdAt,
        companies: w.companyIds.map((id) => {
          const r = readiness(w, id, images.get(id)?.commit ?? null, images.get(id)?.tc ?? null);
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
