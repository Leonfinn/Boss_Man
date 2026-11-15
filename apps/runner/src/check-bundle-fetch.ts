// A check worker gets a job's code before the check (DR-060 part 2, BOS-1436). The company runner has uploaded a git
// bundle of the job's commit and its origin/<main> to the server; the worker downloads it with its own token, checks the
// size and sha256, and takes it into its repo for the project. When a thin bundle's base isn't here it asks once for the
// full history (check.needCode); when that fails too, or the code can't be had at all, it says so (check.noCode) and
// the server puts the job back in line: a worker that can't get the code never reports a failed check.
import { rmSync } from "node:fs";
import path from "node:path";
import type { WorkerMessage, WorkerRepos } from "@boss-man/shared";
import type { CheckRunCommand } from "./check-jobs.js";
import type { Workspaces } from "./workspace.js";

export type BundleFetchDeps = {
  workspaces: Pick<Workspaces, "takeCheckBundle" | "checkBundleScratch" | "checkBundleHaves">;
  /** Downloads the job's bundle into file; null when it arrived whole, else why not. */
  download: (jobId: string, file: string, want: { bytes: number; sha256: string }) => Promise<string | null>;
  send: (m: WorkerMessage) => void;
  log?: (m: string) => void;
  /** Told what the worker holds after each fetch, so the next hello carries it too. */
  onRepos?: (repos: WorkerRepos) => void;
};

export function bundleFetcher(deps: BundleFetchDeps) {
  // Jobs that already asked for the full history: a second miss gives up. Cleared once the job has its code or gives up.
  const askedFull = new Set<string>();
  const log = deps.log ?? (() => {});

  const giveUp = (jobId: string, reason: string) => {
    askedFull.delete(jobId);
    log(`check job ${jobId}: couldn't get the code (${reason}); the server puts it back in line`);
    deps.send({ type: "check.noCode", jobId, reason: reason.slice(0, 500) });
    return false;
  };

  return async function prepare(cmd: CheckRunCommand): Promise<boolean> {
    const b = cmd.bundle;
    if (!b) return giveUp(cmd.jobId, "the server sent the job without its code");
    let dir: string | null = null;
    try {
      let file: string | null = null;
      if (!b.empty) {
        dir = deps.workspaces.checkBundleScratch();
        file = path.join(dir, "job.bundle");
        const bad = await deps.download(cmd.jobId, file, b);
        if (bad) return giveUp(cmd.jobId, bad);
      }
      const r = await deps.workspaces.takeCheckBundle({ projectId: cmd.projectId, jobId: cmd.jobId, commit: cmd.commit, mainRef: b.mainRef, mainCommit: b.mainCommit }, file);
      if (!r.ok) {
        if (r.missing && !askedFull.has(cmd.jobId)) {
          askedFull.add(cmd.jobId);
          log(`check job ${cmd.jobId}: ${r.reason}; asking for the full history`);
          deps.send({ type: "check.needCode", jobId: cmd.jobId });
          return false;
        }
        return giveUp(cmd.jobId, r.reason);
      }
      askedFull.delete(cmd.jobId);
      log(`check job ${cmd.jobId}: got the code (${b.empty ? "already here" : `${b.bytes} bytes`})`);
      const repos = await deps.workspaces.checkBundleHaves().catch(() => null);
      if (repos) {
        deps.onRepos?.(repos);
        deps.send({ type: "check.haves", repos });
      }
      return true;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  };
}
