// The agent fence (DR-004, BOS-321). Each agent session's adapter is started through a small
// Landlock helper, so the adapter and everything it starts (Claude Code, shell commands, file
// edits, browsers) can only write the session's own folders, and can't read other agents' files
// and secrets, signal the runner, or reach other sessions' sockets. Proven in the BOS-315 spike.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxReport } from "@boss-man/shared";

export const FENCE_HELPER = fileURLToPath(new URL("./fence/landlock.pl", import.meta.url));
/** The runner's install (/home/node/app in the image): the adapters live in its node_modules. */
export const APP_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export type FenceLevel = SandboxReport["level"];
export type LandlockProbe = { abi: number; errno: string | null };

/** The kernel's Landlock ABI, asked through the helper (AppArmor hides /sys/kernel/security/lsm in containers). */
export function probeLandlock(): LandlockProbe {
  const r = spawnSync("perl", [FENCE_HELPER, "--probe"], { encoding: "utf8", timeout: 10_000 });
  try {
    const p = JSON.parse(r.stdout) as { abi?: unknown; errno?: unknown };
    return { abi: typeof p.abi === "number" && p.abi > 0 ? p.abi : 0, errno: typeof p.errno === "string" ? p.errno : null };
  } catch {
    return { abi: 0, errno: (r.error?.message ?? r.stderr?.trim()) || "the fence helper didn't run" };
  }
}

/**
 * What an ABI can fence. Below 2 every rename across folders is refused, which breaks git and
 * pnpm, so it counts as unavailable. Full needs 6: signal and abstract-socket scoping.
 */
export function levelFor(abi: number): { level: FenceLevel; missing: string[] } {
  if (abi < 2) return { level: "unavailable", missing: [] };
  const missing: string[] = [];
  if (abi < 3) missing.push("truncating files by path");
  if (abi < 5) missing.push("device ioctl");
  if (abi < 6) missing.push("signals and sockets of other sessions");
  return { level: missing.length ? "partial" : "full", missing };
}

export type FenceRules = { ro: string[]; rw: string[]; roFiles: string[]; rwFiles: string[] };

const SYSTEM_RO = ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc", "/opt", "/proc", "/sys", "/dev"];
const DEVICES_RW = ["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty", "/dev/ptmx"];

export type FenceSpec = {
  /** The session's working folder: the ticket's worktree, a review copy, or a chat folder. */
  cwd: string;
  /** The agent's own home (harness state and caches) and this run's temp folder inside it. */
  home: string;
  tmp: string;
  /** The ticket's shared bare repo and its worktree's admin folder, while tickets use worktrees (until Sandbox 3). */
  repo?: { bare: string; admin: string | null };
  /** More folders to read (skills, the adapter's install) or write (the pnpm store, the check queue). */
  readOnly?: string[];
  readWrite?: string[];
};

/**
 * The rules for one session. Nothing is granted on the workspaces root or the shared Claude
 * folder: a rule covers everything beneath it, so it would expose other tickets and agents.
 * The shared repo is readable, but only what a commit writes (objects, refs, logs and this
 * worktree's admin folder) is writable: its config and hooks, which the runner's own git
 * reads, stay out of reach.
 */
export function fenceProfile(spec: FenceSpec): FenceRules {
  const ro = [...SYSTEM_RO, APP_ROOT, ...(spec.readOnly ?? [])];
  const rw = [spec.cwd, spec.home, spec.tmp, "/dev/shm", "/dev/pts", ...(spec.readWrite ?? [])];
  if (spec.repo) {
    ro.push(spec.repo.bare);
    rw.push(...["objects", "refs", "logs"].map((d) => path.join(spec.repo!.bare, d)));
    if (spec.repo.admin) rw.push(spec.repo.admin);
  }
  const uniq = (list: string[]) => [...new Set(list.filter(Boolean).map((p) => path.resolve(p)))];
  return { ro: uniq(ro), rw: uniq(rw), roFiles: [], rwFiles: DEVICES_RW };
}

/** The command that runs bin inside the fence. */
export function fencedCommand(rules: FenceRules, bin: string, args: string[]): { bin: string; args: string[] } {
  const flags = [
    ...rules.ro.flatMap((p) => ["--ro", p]),
    ...rules.rw.flatMap((p) => ["--rw", p]),
    ...rules.roFiles.flatMap((p) => ["--rofile", p]),
    ...rules.rwFiles.flatMap((p) => ["--rwfile", p]),
  ];
  return { bin: "perl", args: [FENCE_HELPER, ...flags, "--", bin, ...args] };
}

/**
 * A worktree's admin folder in the shared repo: the one folder that points at the worktree
 * (its gitdir file) and that the worktree points at (its .git file). Each side can be rewritten
 * by one agent only, so no agent can get another's folder granted; an agent that breaks its own
 * link gets none, and its git stops working.
 */
export function worktreeAdmin(bare: string, cwd: string): string | null {
  const dir = path.join(bare, "worktrees");
  const dotGit = path.join(path.resolve(cwd), ".git");
  let pointsTo: string | null = null;
  try {
    const m = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));
    pointsTo = m ? path.resolve(cwd, m[1]!.trim()) : null;
  } catch {
    return null;
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const linked = names.filter((name) => {
    const admin = path.join(dir, name);
    try {
      return admin === pointsTo && readFileSync(path.join(admin, "gitdir"), "utf8").trim() === dotGit;
    } catch {
      return false;
    }
  });
  return linked.length === 1 ? path.join(dir, linked[0]!) : null;
}

/**
 * The shared repo's grant for a session working in one of its worktrees. Git won't create the
 * folders a commit writes once the repo's root is read-only, so they're made here first.
 */
export function repoGrant(bare: string, cwd: string): { bare: string; admin: string | null } {
  for (const d of ["objects", "refs", "logs"]) mkdirSync(path.join(bare, d), { recursive: true });
  return { bare, admin: worktreeAdmin(bare, cwd) };
}

/**
 * Where scripts/check-all.sh keeps its state, shared by fenced sessions, unfenced ones and the
 * merge check so checks still take turns (its defaults in /tmp and /var/tmp are outside every
 * fence). queue/ holds the slot locks and queue entries, which a session must write to take part.
 * gate/ holds the stored results and the side-by-side pair proof, which sessions may only read:
 * a forged proof would run two checks at once before a pair was measured (BOS-321 review).
 */
export const checkQueueDirs = (dir: string) => ({ queue: path.join(dir, "queue"), gate: path.join(dir, "gate") });

export const checkQueueEnv = (dir: string) => {
  const { queue, gate } = checkQueueDirs(dir);
  return {
    CHECK_ALL_LOCK: path.join(queue, "check-all"),
    BOSSMAN_CHECK_STORE: path.join(gate, "check-results"),
    CHECK_ALL_PAIR_PROOF: path.join(gate, "check-pair-passed"),
  };
};

/** Makes the check folders and returns the session's grant: the queue read-write, the gate read-only. */
export function checkQueueGrant(dir: string): { readWrite: string; readOnly: string } {
  const { queue, gate } = checkQueueDirs(dir);
  mkdirSync(queue, { recursive: true });
  mkdirSync(path.join(gate, "check-results"), { recursive: true });
  return { readWrite: queue, readOnly: gate };
}

/** Claude Code's folder name for a project: its path with everything but letters and digits as "-". */
export const claudeProjectSlug = (p: string) => path.resolve(p).replace(/[^a-zA-Z0-9]/g, "-");

/** Adds a git setting through the environment, after any already there (e.g. the auth header). */
export function addGitConfig(env: NodeJS.ProcessEnv, key: string, value: string) {
  const n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  env[`GIT_CONFIG_KEY_${n}`] = key;
  env[`GIT_CONFIG_VALUE_${n}`] = value;
  env.GIT_CONFIG_COUNT = String(n + 1);
}

/**
 * The runner's fence setting for its SessionManager: its self-tested level, each agent's home in
 * the runner's data volume, and the pnpm store under the workspaces volume's root.
 * The store is always a folder under the volume, never the volume's root itself or `/`: the fence
 * grants everything beneath a rule, so the root would hand agents the whole volume (other agents'
 * copies, the merge gate's results), and the gate's own store (`<store>-gate`) would land on the
 * runner's root disk (BOS-633).
 */
export function runnerFence(level: FenceLevel, dataDir: string, workspacesRoot: string) {
  return { level, agentsRoot: path.join(dataDir, "agents"), pnpmStore: path.join(workspacesRoot, ".pnpm-store") };
}

/**
 * The shared pnpm store the runner will actually use (BOS-568), where PNPM_STORE_DIR may move it (e.g. to a
 * folder on a bigger volume). Empty means `<workspacesRoot>/.pnpm-store`. The value must be a folder strictly
 * under the workspaces volume: `/`, the volume's root and anything above it are refused, since the fence would
 * grant the whole volume and the gate store beside the store would leave the volume's own disk (BOS-633).
 */
export function pnpmStoreDir(workspacesRoot: string, raw: string | undefined): string {
  const p = (raw ?? "").trim();
  if (!p) return path.join(workspacesRoot, ".pnpm-store");
  if (!p.startsWith("/") || p.includes("\0") || p.split("/").includes("..")) throw new Error(`PNPM_STORE_DIR should be an absolute path inside the runner, like ${path.join(workspacesRoot, ".pnpm-store")}, not ${raw}`);
  const resolved = path.posix.normalize(p).replace(/\/+$/, "") || "/";
  const root = path.resolve(workspacesRoot);
  if (resolved === "/" || resolved === root || !resolved.startsWith(root + "/")) {
    throw new Error(`PNPM_STORE_DIR must be a folder under ${root} (the runner's only writable volume), not ${raw}: the volume's root would grant agents the whole volume and put the gate's store on the root disk`);
  }
  return resolved;
}

/**
 * What this runner can fence, reported at start-up. The probe proves the helper end to end:
 * a fenced write inside its folder must work and one outside must be refused.
 */
export function sandboxSelfTest(): SandboxReport {
  const { abi, errno } = probeLandlock();
  const { level, missing } = levelFor(abi);
  const userns = spawnSync("unshare", ["-Ur", "true"], { stdio: "ignore", timeout: 10_000 }).status === 0;
  let probe: boolean | null = null;
  if (level !== "unavailable") {
    const root = mkdtempSync(path.join(tmpdir(), "bm-fence-probe-"));
    try {
      const inside = path.join(root, "in");
      const outside = path.join(root, "out");
      mkdirSync(inside);
      mkdirSync(outside);
      const rules = fenceProfile({ cwd: inside, home: inside, tmp: inside });
      const cmd = fencedCommand(rules, "/bin/sh", ["-c", 'echo ok > "$1/x"; echo no > "$2/x"', "sh", inside, outside]);
      spawnSync(cmd.bin, cmd.args, { stdio: "ignore", timeout: 10_000 });
      probe = existsSync(path.join(inside, "x")) && !existsSync(path.join(outside, "x"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return { landlockAbi: abi, errno, level: probe === false ? "unavailable" : level, missing, userns, probe };
}

/**
 * Prunes one pnpm store of packages no install references any more (BOS-633). Both stores only ever grow as
 * lockfiles change, on the volume every agent's work lives on, so the runner does this daily. pnpm's store
 * lock makes it safe beside a running install, and it never removes a package something still links to.
 * Never throws: a missing store, a wrong pnpm or a busy lock is logged and skipped, and there is always the next run.
 */
export function pruneStore(storeDir: string, log: (m: string) => void = () => {}, bin = "pnpm"): { pruned: boolean; why?: string } {
  if (!existsSync(storeDir)) return { pruned: false, why: "no store yet" };
  const r = spawnSync(bin, ["store", "prune", "--store-dir", storeDir], { encoding: "utf8", timeout: 10 * 60_000 });
  if (r.error) {
    log(`pnpm store prune of ${storeDir} failed: ${r.error.message}`);
    return { pruned: false, why: r.error.message };
  }
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ") || `exit ${r.status}`;
    log(`pnpm store prune of ${storeDir} failed: ${why}`);
    return { pruned: false, why };
  }
  log(`pnpm store prune of ${storeDir}: ${(r.stdout || "").trim().split("\n").pop() ?? "done"}`);
  return { pruned: true };
}

/** Prunes the shared store and the gate's store beside it, in turn, one failing without stopping the other. */
export function pruneStores(shared: string, log: (m: string) => void = () => {}, bin = "pnpm") {
  return { shared: pruneStore(shared, log, bin), gate: pruneStore(`${shared}-gate`, log, bin) };
}

/**
 * Applies the operator's BOSSMAN_CHECK_SLOTS (how many full checks may run at once on this host) by writing
 * or removing the proof file in gate/, which sessions can only read. Unset, empty, "1" or anything that is not
 * a whole number from 2 to 16 means one at a time (the safe default). A hand-made proof file (a pair-measurement
 * note) is left alone when the setting is unset, but a number written earlier by this function is removed.
 * Returns the slots set, or 0 when the setting was unset.
 */
export function applyCheckSlots(dir: string, raw: string | undefined): number {
  const { gate } = checkQueueDirs(dir);
  const proof = path.join(gate, "check-pair-passed");
  const text = (raw ?? "").trim();
  if (text === "") {
    if (existsSync(proof) && /^\d+\s*$/.test(readFileSync(proof, "utf8"))) rmSync(proof, { force: true });
    return 0;
  }
  const n = /^\d{1,2}$/.test(text) ? Number(text) : 1;
  const slots = n >= 2 && n <= 16 ? n : 1;
  mkdirSync(gate, { recursive: true });
  if (slots > 1) writeFileSync(proof, `${slots}\n`);
  else rmSync(proof, { force: true });
  return slots;
}
