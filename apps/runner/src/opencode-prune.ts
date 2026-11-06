// OpenCode keeps every session it has ever run (messages, parts and its event log) in one SQLite
// file and never deletes any, so on a busy runner it grows by about a gigabyte a day (BOS-616).
// This removes sessions nobody has touched for a while, a few at a time, through OpenCode's own
// `opencode session delete` so the rows it owns (events included) go the way OpenCode expects and a
// schema change in a new OpenCode can't leave half a session behind. The delete waits for the
// database lock like any other OpenCode writer, so it is safe while runs are live. It never runs a
// VACUUM: the freed pages are reused by new sessions, so the file stops growing instead of shrinking.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

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
}

export interface OpencodePruneResult {
  databases: number;
  deleted: number;
  failed: number;
}

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
  const result: OpencodePruneResult = { databases: 0, deleted: 0, failed: 0 };
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
  }
  return result;
}
