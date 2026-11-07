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
//
// Backup first: before the first delete in each database, the runner copies it (VACUUM INTO) into
// its own folder, checks the copy (integrity_check, session count) and writes a marker. If that
// fails, nothing in that database is deleted. The copy is removed after BACKUP_KEEP_DAYS.
//
// Agent homes are the agent's (BOS-321 treats agents as untrusted), so OpenCode is never started
// inside one: it runs from a runner-owned empty folder (OpenCode loads project plugins from the
// folders above its cwd) with only the base environment, and links in an agent home are refused.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { BASE_ENV_KEYS } from "./session-manager.js";

export interface OpencodePruneOptions {
  /** Sessions not updated for this many days go; 0 or less turns the prune off. */
  keepDays: number;
  /** At most this many sessions per database per pass, so one pass stays short. */
  batch?: number;
  /** XDG data folders that may hold an `opencode/opencode.db`. */
  dataHomes: string[];
  /** Session ids a live run is using right now: never deleted, whatever their age. */
  activeSessionIds?: () => Iterable<string>;
  /** The environment OpenCode's base keys (PATH, HOME, ...) come from; nothing else of it is passed. XDG_DATA_HOME is set per database. */
  env?: NodeJS.ProcessEnv;
  /**
   * Runner-owned folder for the checked backups, their markers and the empty folder OpenCode runs
   * in. Must not be inside an agent home. Without it nothing is deleted (there is nowhere to back up to).
   */
  stateDir?: string;
  /** Fenced agents' homes live here: every folder from it down to opencode.db must be real (no links). */
  agentsRoot?: string | null;
  /** Days a backup copy is kept after it was made (default 7); its marker stays, so it is made once. */
  backupKeepDays?: number;
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
  /** Databases backed up and checked this pass. */
  backedUp: number;
}

interface BackupReport {
  ok: boolean;
  why: string;
  sessions: number;
  bytes: number;
}

/** Copies a database with VACUUM INTO and checks the copy opens, passes integrity_check and has every session. */
const BACKUP_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { file, copy } = workerData;
const one = (db, sql) => Object.values(db.prepare(sql).get())[0];
const src = new DatabaseSync(file, { readOnly: true });
let before;
try {
  src.exec("pragma busy_timeout = 10000");
  before = one(src, "select count(*) from session");
  src.exec("vacuum into '" + copy.replace(/'/g, "''") + "'");
} finally {
  src.close();
}
const db = new DatabaseSync(copy, { readOnly: true });
try {
  const check = db.prepare("pragma integrity_check").all().map((r) => Object.values(r)[0]);
  const sessions = one(db, "select count(*) from session");
  const ok = check.length === 1 && check[0] === "ok" && sessions >= before;
  const why = ok ? "" : check[0] !== "ok" ? "integrity_check: " + String(check[0]).slice(0, 200) : "the copy has " + sessions + " sessions, the database had " + before;
  parentPort.postMessage({ ok, why, sessions, bytes: require("node:fs").statSync(copy).size });
} finally {
  db.close();
}
`;

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

function inWorker<T>(source: string, workerData: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData, stderr: true });
    let report: T | null = null;
    worker.once("message", (m: T) => (report = m));
    worker.once("error", reject);
    worker.once("exit", (code) => (report ? resolve(report) : reject(new Error(`the SQLite worker exited with code ${code}`))));
  });
}

const vacuumInWorker = (file: string, convert: boolean, stepPages: number, maxSteps: number) =>
  inWorker<VacuumReport>(VACUUM_WORKER, { file, convert, stepPages, maxSteps });

const defaultFreeBytes = (dir: string) => {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
};

export const DEFAULT_KEEP_DAYS = 14;
const DEFAULT_BATCH = 50;
const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

/** BOSSMAN_OPENCODE_SESSION_DAYS: a whole number of days, 0 to turn the prune off. Anything else falls back to the default. */
export function keepDaysFrom(value: string | undefined, warn?: (m: string) => void): number {
  if (value === undefined || value.trim() === "") return DEFAULT_KEEP_DAYS;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0) return n;
  warn?.(`BOSSMAN_OPENCODE_SESSION_DAYS=${JSON.stringify(value.slice(0, 40))} isn't a whole number of days: using ${DEFAULT_KEEP_DAYS}`);
  return DEFAULT_KEEP_DAYS;
}

const DAY = 86_400_000;
const DEFAULT_BACKUP_KEEP_DAYS = 7;
/** After a failed backup check, the next try waits this long (a bad copy of a large file is costly to repeat hourly). */
const BACKUP_RETRY_MS = DAY;

/**
 * The database file to work on, null when there is none, or why it is refused. In an agent home every
 * folder from the agents' root down must be a real folder and the files real files: a link could
 * point the runner's SQLite (which writes the -wal and -shm files) at a file of the runner's.
 */
function databaseFile(dataHome: string, agentsRoot: string | null | undefined): { file: string } | { refused: string } | null {
  const file = path.join(dataHome, "opencode", "opencode.db");
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (!st) return null;
  if (!st.isFile()) return { refused: `${file} isn't a regular file` };
  const rel = agentsRoot ? path.relative(agentsRoot, path.dirname(file)) : "";
  if (agentsRoot && rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    let at = agentsRoot;
    for (const part of rel.split(path.sep)) {
      at = path.join(at, part);
      if (!lstatSync(at, { throwIfNoEntry: false })?.isDirectory()) return { refused: `${at} isn't a real folder` };
    }
  }
  for (const extra of ["-wal", "-shm", "-journal"]) {
    const s = lstatSync(file + extra, { throwIfNoEntry: false });
    if (s && !s.isFile()) return { refused: `${file}${extra} isn't a regular file` };
  }
  return { file };
}

/** OpenCode gets only the base environment (no runner token or other settings), pointed at one database. */
function opencodeEnvFor(base: NodeJS.ProcessEnv, dataHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of BASE_ENV_KEYS) if (base[k] !== undefined) env[k] = base[k];
  return { ...env, XDG_DATA_HOME: dataHome, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" };
}

interface BackupMarker {
  dataHome: string;
  copy: string;
  sessions: number;
  bytes: number;
  at: number;
  removedAt?: number;
}

const backupKey = (dataHome: string) => createHash("sha256").update(path.resolve(dataHome)).digest("hex").slice(0, 16);

/** Removes backup copies older than keepDays; their markers stay so a database is only backed up once. */
function expireBackups(dir: string, keepDays: number, now: number, log: (m: string) => void) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const markerPath = path.join(dir, name);
    let m: BackupMarker;
    try {
      m = JSON.parse(readFileSync(markerPath, "utf8")) as BackupMarker;
    } catch {
      continue;
    }
    if (m.removedAt || now - m.at < keepDays * DAY) continue;
    rmSync(path.join(dir, `${name.slice(0, -5)}.db`), { force: true });
    writeFileSync(markerPath, JSON.stringify({ ...m, removedAt: now }));
    log(`OpenCode session prune: removed the ${keepDays}-day-old backup of ${m.dataHome}`);
  }
}

/**
 * "made" or "had" once a checked backup of the database exists (made now, or on an earlier pass).
 * null means don't delete anything in it: no room for the copy, or the copy failed its check.
 */
async function ensureBackup(dataHome: string, file: string, dir: string, opts: OpencodePruneOptions, now: number, log: (m: string) => void): Promise<"made" | "had" | null> {
  const key = backupKey(dataHome);
  const markerPath = path.join(dir, `${key}.json`);
  const copy = path.join(dir, `${key}.db`);
  const failedPath = path.join(dir, `${key}.failed`);
  if (existsSync(markerPath)) return "had";
  const failedAt = existsSync(failedPath) ? Number(readFileSync(failedPath, "utf8")) || 0 : 0;
  if (failedAt && now - failedAt < BACKUP_RETRY_MS) return null;
  const size = statSync(file).size + (statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0);
  const free = (opts.freeBytes ?? defaultFreeBytes)(dir);
  // VACUUM INTO writes at most the live pages; keep 1 GB spare for everything else on the disk.
  if (free < size + 1024 ** 3) {
    log(`OpenCode session prune: not deleting in ${dataHome} yet: its backup needs ${gib(size + 1024 ** 3)} free and only ${gib(free)} is`);
    return null;
  }
  rmSync(copy, { force: true }); // VACUUM INTO refuses to overwrite: this is a half copy from a crash
  let report: BackupReport;
  try {
    report = await inWorker<BackupReport>(BACKUP_WORKER, { file, copy });
  } catch (err) {
    report = { ok: false, why: String((err as Error)?.message ?? err), sessions: 0, bytes: 0 };
  }
  if (!report.ok) {
    rmSync(copy, { force: true });
    writeFileSync(failedPath, String(now));
    log(`OpenCode session prune: not deleting in ${dataHome}: its backup failed (${report.why.slice(0, 300)}); trying again in a day`);
    return null;
  }
  rmSync(failedPath, { force: true });
  const marker: BackupMarker = { dataHome, copy, sessions: report.sessions, bytes: report.bytes, at: now };
  writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });
  log(`OpenCode session prune: backed up ${dataHome} (${report.sessions} sessions, ${gib(report.bytes)}, integrity ok) to ${copy}`);
  return "made";
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
  const result: OpencodePruneResult = { databases: 0, deleted: 0, failed: 0, reclaimedBytes: 0, converted: 0, backedUp: 0 };
  if (!(opts.keepDays > 0)) return result;
  const bin = opts.bin ?? "opencode";
  const batch = opts.batch ?? DEFAULT_BATCH;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now();
  const cutoff = Math.floor(now - opts.keepDays * DAY);
  if (!opts.stateDir) {
    log("OpenCode session prune: no folder for its backups, so nothing is deleted");
    return result;
  }
  const backupDir = path.join(opts.stateDir, "backups");
  // OpenCode looks for project config and plugins from its cwd upwards: run it from a folder only the runner writes to.
  const cwd = path.join(opts.stateDir, "cwd");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  expireBackups(backupDir, opts.backupKeepDays ?? DEFAULT_BACKUP_KEEP_DAYS, now, log);

  for (const dataHome of opts.dataHomes) {
    const db = databaseFile(dataHome, opts.agentsRoot);
    if (!db) continue;
    result.databases++;
    if ("refused" in db) {
      log(`OpenCode session prune: skipping ${dataHome}: ${db.refused}`);
      result.failed++;
      continue;
    }
    const env = opencodeEnvFor(opts.env ?? process.env, dataHome);
    const active = new Set(opts.activeSessionIds?.() ?? []);
    // The cutoff is a number we built, so the query has nothing from outside in it.
    const query = `select id from session where time_updated < ${cutoff} order by time_updated limit ${batch + active.size}`;
    const listed = await run(bin, ["db", query, "--format", "json"], env, cwd);
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
    if (ids.length) {
      const backup = await ensureBackup(dataHome, db.file, backupDir, opts, now, log);
      if (!backup) {
        result.failed++;
        continue;
      }
      if (backup === "made") result.backedUp++;
    }
    for (const id of ids) {
      const r = await run(bin, ["session", "delete", id], env, cwd);
      if (r.code === 0) result.deleted++;
      else {
        result.failed++;
        log(`OpenCode session prune: couldn't delete ${id}: ${r.stderr.trim().slice(0, 300)}`);
      }
    }
    await reclaim(db.file, opts, result, log);
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
    // The backup copy is already on disk by now (it is made first), so this free figure counts it.
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
