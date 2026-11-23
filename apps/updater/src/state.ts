// The updater's state file (design section 5, "state kept in the updater's volume after each step"): one small JSON file,
// written atomically, so a restart in the middle of a move finds out where it was and cleans up. It also holds the plain-words
// report the owner is shown, which stays until the owner (through the server) acknowledges it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UpdaterError } from "./config.js";

/** verifying -> pulling -> installing-pack -> ready-to-swap (941a stops here). 941b adds the swap's stages. */
export type Stage = "idle" | "verifying" | "pulling" | "installing-pack" | "ready-to-swap" | "failed";
export const RUNNING_STAGES: readonly Stage[] = ["verifying", "pulling", "installing-pack"];

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
};

export const emptyState = (now: string): State => ({ stage: "idle", version: null, serverDigest: null, startedAt: null, updatedAt: now, error: null, report: null });

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
        const stages: Stage[] = ["idle", "verifying", "pulling", "installing-pack", "ready-to-swap", "failed"];
        if (parsed && stages.includes(parsed.stage)) current = { ...emptyState(now()), ...parsed };
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
      return this.update({ stage: "verifying", version, serverDigest, startedAt: now(), error: null, report: null });
    },
    fail(err: { code: string; message: string }): State {
      return this.update({ stage: "failed", error: { code: err.code, message: err.message }, report: { level: "problem", text: err.message, at: now(), acknowledged: false } });
    },
    acknowledge(): State {
      return this.update({ report: current.report ? { ...current.report, acknowledged: true } : null });
    },
  };
}

export type StateStore = ReturnType<typeof stateStore>;
