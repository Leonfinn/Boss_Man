// The updater's state file (design section 5, "state kept in the updater's volume after each step"): one small JSON file,
// written atomically, so a restart in the middle of a move finds out where it was and cleans up. It also holds the plain-words
// report the owner is shown, which stays until the owner (through the server) acknowledges it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UpdaterError } from "./config.js";

/**
 * verifying -> pulling -> installing-pack -> (without swap settings: ready-to-swap) -> backing-up -> migrating -> starting-colour
 * -> handing-over -> flipping -> soaking -> stopping-old -> done. A move ends in done, rolled-back or failed. updating-updater is
 * the last step (the updater's own hand-over, design section 8).
 */
export const ALL_STAGES = ["idle", "verifying", "pulling", "installing-pack", "ready-to-swap", "backing-up", "migrating", "starting-colour", "handing-over", "flipping", "soaking", "stopping-old", "updating-updater", "done", "rolled-back", "failed"] as const;
export type Stage = (typeof ALL_STAGES)[number];
/** Stages before the first change to anything live: a restart here only removes what the move made. */
export const PRE_SWAP_STAGES: readonly Stage[] = ["verifying", "pulling", "installing-pack", "backing-up", "migrating", "starting-colour", "handing-over"];
export const RUNNING_STAGES: readonly Stage[] = [...PRE_SWAP_STAGES, "flipping", "soaking", "stopping-old", "updating-updater"];

export type Report = { level: "info" | "problem"; text: string; at: string; acknowledged: boolean };

export type State = {
  stage: Stage;
  /** The release being moved to (or last moved to). */
  version: string | null;
  serverDigest: string | null;
  startedAt: string | null;
  updatedAt: string;
  /** A stable code and one plain sentence for the last failure. Cleared when a new move starts. */
  error: { code: string; message: string } | null;
  report: Report | null;
  /** The swap's own record (941b), written after each step so a restart resumes or cleans up. */
  live: "blue" | "green" | null;
  idle: "blue" | "green" | null;
  /** When the soak ends (ISO). */
  soakUntil: string | null;
  backup: string | null;
  /** True when the move goes to the standby's release (no pull, no backup, no migrate). */
  restore: boolean;
  /** The release the install runs, once a swap has finished; before that the configured one. */
  currentVersion: string | null;
  /** The digest of the new updater, when the updater's own hand-over is in progress. */
  nextUpdater: string | null;
  /** A move the new updater carries on with after the updater updated itself first (a release that needs a newer layout). */
  pending: { version: string; serverDigest: string } | null;
  /** The commit the new colour must report (from the signed release), kept so a restart can still judge the new colour. */
  commit: string | null;
};

export const emptyState = (now: string): State => ({ stage: "idle", version: null, serverDigest: null, startedAt: null, updatedAt: now, error: null, report: null, live: null, idle: null, soakUntil: null, backup: null, restore: false, currentVersion: null, nextUpdater: null, pending: null, commit: null });

export function stateStore(dir: string, now: () => string = () => new Date().toISOString()) {
  const file = path.join(dir, "state.json");
  let current: State = emptyState(now());
  const save = () => {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    /** Reads the file; a missing or damaged one is an idle state (a damaged file is never trusted). */
    load(): State {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as State;
        if (parsed && (ALL_STAGES as readonly string[]).includes(parsed.stage)) current = { ...emptyState(now()), ...parsed };
      } catch {
        current = emptyState(now());
      }
      return current;
    },
    get(): State {
      return current;
    },
    /** Applies a change and writes it before returning. */
    update(change: Partial<State>): State {
      current = { ...current, ...change, updatedAt: now() };
      save();
      return current;
    },
    begin(version: string, serverDigest: string): State {
      if (RUNNING_STAGES.includes(current.stage)) throw new UpdaterError("busy", "Another update is already running.");
      return this.update({ stage: "verifying", version, serverDigest, startedAt: now(), error: null, report: null, idle: null, soakUntil: null, backup: null, restore: false, nextUpdater: null, pending: null, commit: null });
    },
    fail(err: { code: string; message: string }): State {
      return this.update({ stage: "failed", error: { code: err.code, message: err.message }, report: { level: "problem", text: err.message, at: now(), acknowledged: false } });
    },
    /** Ends a move as done or rolled-back with the plain-words report the owner is shown. */
    finish(stage: "done" | "rolled-back", text: string, level: "info" | "problem" = stage === "done" ? "info" : "problem", extra: Partial<State> = {}): State {
      return this.update({ ...extra, stage, error: null, report: { level, text, at: now(), acknowledged: false } });
    },
    acknowledge(): State {
      return this.update({ report: current.report ? { ...current.report, acknowledged: true } : null });
    },
  };
}

export type StateStore = ReturnType<typeof stateStore>;
