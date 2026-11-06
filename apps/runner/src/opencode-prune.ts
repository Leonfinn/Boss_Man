// OpenCode keeps every session it has ever run (messages, parts and its event log) in one SQLite
// file and never deletes any, so on a busy runner it grows by about a gigabyte a day (BOS-616).
// This removes sessions nobody has touched for a while, a few at a time, through OpenCode's own
// `opencode session delete` so the rows it owns (events included) go the way OpenCode expects and a
// schema change in a new OpenCode can't leave half a session behind. The delete waits for the
// database lock like any other OpenCode writer, so it is safe while runs are live.
//
// Giving the space back: SQLite only shrinks a file with VACUUM. Once per database, at a moment
// when no OpenCode run is live (new ones are held meanwhile, because OpenCode gives up on a lock
// after 5 s), the database is switched to incremental auto-vacuum with one full VACUUM. After that
// every pass returns the freed pages in small `incremental_vacuum` steps, each a short write that
// live runs wait out. All SQLite work runs in a worker thread so a long VACUUM can't stall the
// runner's connection to the server.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync, statfsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

export interface OpencodePruneOptions {
  /** Sessions not updated for this many days go; 0 or less turns the prune off. */
  keepDays: number;
  /** At most this many sessions per database per pass, so one pass stays short. */
  batch?: number;
  /** XDG data folders that may hold an `opencode/opencode.db`. */
  dataHomes: string[];
  /** Session ids a live run is using right now: never deleted, whatever their age. */
  activeSessionIds?: () => Iterable<string>;
  /** The environment OpenCode runs with (PATH, HOME); XDG_DATA_HOME is set per database. */
  env?: NodeJS.ProcessEnv;
  bin?: string;
  now?: number;
  log?: (m: string) => void;
  /**
   * Runs fn with no OpenCode run live and new ones held until it settles; resolves null without
   * running it when a run is live. Without it the one-off VACUUM is never attempted.
   */
  whileOpencodeIdle?: <T>(fn: () => Promise<T>) => Promise<T | null>;
  /** Free bytes on the disk holding a folder (for tests); the VACUUM needs about twice the file. */
  freeBytes?: (dir: string) => number;
  /** Pages per incremental_vacuum step (default 2000, 8 MB at 4 KB pages) and steps per pass (default 64). */
  stepPages?: number;
  maxSteps?: number;
}

export interface OpencodePruneResult {
  databases: number;
  deleted: number;
  failed: number;
  /** Bytes the database files gave back this pass. */
  reclaimedBytes: number;
  /** Databases switched to incremental auto-vacuum this pass. */
  converted: number;
}

interface VacuumReport {
  mode: number;
  converted: boolean;
  steps: number;
  freedBytes: number;
  bytes: number;
}

// Runs in a worker thread (node:sqlite is synchronous). Pragmas only: nothing here depends on OpenCode's schema.
const VACUUM_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { file, convert, stepPages, maxSteps } = workerData;
const db = new DatabaseSync(file);
try {
  const get = (p) => Object.values(db.prepare("pragma " + p).get())[0];
  db.exec("pragma busy_timeout = 10000");
  const pageSize = get("page_size");
  const before = get("page_count");
  let mode = get("auto_vacuum");
  let converted = false;
  if (mode === 0 && convert) {
    db.exec("pragma auto_vacuum = 2");
    db.exec("vacuum");
    db.exec("pragma wal_checkpoint(TRUNCATE)");
    mode = get("auto_vacuum");
    converted = mode === 2;
  }
  let steps = 0;
  if (mode === 2) {
    while (steps < maxSteps && get("freelist_count") > 0) {
      db.exec("pragma incremental_vacuum(" + stepPages + ")");
      steps++;
    }
    if (steps) db.exec("pragma wal_checkpoint(PASSIVE)");
  }
  const after = get("page_count");
  parentPort.postMessage({ mode, converted, steps, freedBytes: (before - after) * pageSize, bytes: after * pageSize });
} finally {
  db.close();
}
`;

function vacuumInWorker(file: string, convert: boolean, stepPages: number, maxSteps: number): Promise<VacuumReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(VACUUM_WORKER, { eval: true, workerData: { file, convert, stepPages, maxSteps }, stderr: true });
    let report: VacuumReport | null = null;
    worker.once("message", (m: VacuumReport) => (report = m));
    worker.once("error", reject);
    worker.once("exit", (code) => (report ? resolve(report) : reject(new Error(`the vacuum worker exited with code ${code}`))));
  });
}

const defaultFreeBytes = (dir: string) => {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
};

export const DEFAULT_KEEP_DAYS = 14;
const DEFAULT_BATCH = 50;
const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

/** BOSSMAN_OPENCODE_SESSION_DAYS: a whole number of days, 0 to turn the prune off. Anything else falls back to the default. */
export function keepDaysFrom(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_KEEP_DAYS;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_KEEP_DAYS;
}

/** The runner's own OpenCode data folder plus each fenced agent's (BOS-321 gives every agent its own home). */
export function opencodeDataHomes(env: NodeJS.ProcessEnv, agentsRoot: string | null): string[] {
  const homes = [env.XDG_DATA_HOME || path.join(env.HOME ?? "/home/node", ".local", "share")];
  if (agentsRoot && existsSync(agentsRoot)) {
    for (const agent of readdirSync(agentsRoot)) homes.push(path.join(agentsRoot, agent, ".local", "share"));
  }
  return homes;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const c = (err as { code?: unknown } | null)?.code;
      const code = !err ? 0 : typeof c === "number" ? c : c === "ENOENT" ? 127 : 1;
      resolve({ code, stdout: String(stdout), stderr: err && !stderr ? String((err as Error).message) : String(stderr) });
    });
  });
}

export async function pruneOpencodeSessions(opts: OpencodePruneOptions): Promise<OpencodePruneResult> {
  const result: OpencodePruneResult = { databases: 0, deleted: 0, failed: 0, reclaimedBytes: 0, converted: 0 };
  if (!(opts.keepDays > 0)) return result;
  const bin = opts.bin ?? "opencode";
  const batch = opts.batch ?? DEFAULT_BATCH;
  const log = opts.log ?? (() => {});
  const cutoff = Math.floor((opts.now ?? Date.now()) - opts.keepDays * 86_400_000);

  for (const dataHome of opts.dataHomes) {
    if (!existsSync(path.join(dataHome, "opencode", "opencode.db"))) continue;
    result.databases++;
    const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), XDG_DATA_HOME: dataHome, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" };
    const active = new Set(opts.activeSessionIds?.() ?? []);
    // The cutoff is a number we built, so the query has nothing from outside in it.
    const query = `select id from session where time_updated < ${cutoff} order by time_updated limit ${batch + active.size}`;
    const listed = await run(bin, ["db", query, "--format", "json"], env, dataHome);
    if (listed.code === 127) return result; // no OpenCode on this runner: nothing of ours wrote these
    if (listed.code !== 0) {
      log(`OpenCode session prune: couldn't list old sessions in ${dataHome}: ${listed.stderr.trim().slice(0, 300)}`);
      result.failed++;
      continue;
    }
    let ids: string[];
    try {
      const rows = JSON.parse(listed.stdout.trim() || "[]") as Array<{ id?: unknown }>;
      ids = rows.map((r) => String(r.id ?? "")).filter((id) => SESSION_ID.test(id) && !active.has(id)).slice(0, batch);
    } catch {
      log(`OpenCode session prune: unexpected output listing sessions in ${dataHome}`);
      result.failed++;
      continue;
    }
    for (const id of ids) {
      const r = await run(bin, ["session", "delete", id], env, dataHome);
      if (r.code === 0) result.deleted++;
      else {
        result.failed++;
        log(`OpenCode session prune: couldn't delete ${id}: ${r.stderr.trim().slice(0, 300)}`);
      }
    }
    await reclaim(path.join(dataHome, "opencode", "opencode.db"), opts, result, log);
  }
  return result;
}

/** Gives freed pages back to the disk: small steps on a converted database, the one-off conversion when OpenCode is idle. */
async function reclaim(file: string, opts: OpencodePruneOptions, result: OpencodePruneResult, log: (m: string) => void) {
  const stepPages = Math.max(1, Math.floor(opts.stepPages ?? 2000));
  const maxSteps = Math.max(1, Math.floor(opts.maxSteps ?? 64));
  try {
    const r = await vacuumInWorker(file, false, stepPages, maxSteps);
    result.reclaimedBytes += Math.max(0, r.freedBytes);
    if (r.mode !== 0 || !opts.whileOpencodeIdle) return;
    const size = statSync(file).size;
    const free = (opts.freeBytes ?? defaultFreeBytes)(path.dirname(file));
    // VACUUM writes a compacted copy to a temp file and back through the WAL: up to twice the file.
    if (free < 2 * size + 1024 ** 3) {
      log(`OpenCode session prune: ${file} needs one VACUUM to give space back, but only ${gib(free)} is free and it needs ${gib(2 * size + 1024 ** 3)}`);
      return;
    }
    const started = Date.now();
    const done = await opts.whileOpencodeIdle(() => vacuumInWorker(file, true, stepPages, maxSteps));
    if (!done) return; // an OpenCode run is live: try again next pass
    result.reclaimedBytes += Math.max(0, done.freedBytes);
    if (done.converted) result.converted++;
    log(`OpenCode session prune: switched ${file} to incremental vacuum in ${Math.round((Date.now() - started) / 1000)} s (${gib(size)} -> ${gib(done.bytes)})`);
  } catch (err) {
    result.failed++;
    log(`OpenCode session prune: couldn't reclaim space in ${file}: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
  }
}

const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
