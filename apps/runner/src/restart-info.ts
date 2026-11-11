// Why the runner restarted, as far as the runner itself can tell (BOS-594). Two facts go to the server in
// hello, which decides the reason: how the previous process ended, and when the host machine booted.
//   "stopped": the previous process was told to stop (SIGTERM: docker stop, restart or recreate).
//   "crashed": it ended without being told (a crash, or the kernel's out-of-memory killer) and Docker started it again.
// Both files live in the runner's data folder, which survives a recreate.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type PreviousExit = "stopped" | "crashed";

const STOPPED = "stopped";
const STARTED = "started";

/** Read once at start: how the last process ended, or null on the first start this folder has seen. */
export function previousExit(dataDir: string): PreviousExit | null {
  const started = path.join(dataDir, STARTED);
  const stopped = path.join(dataDir, STOPPED);
  const seenBefore = existsSync(started);
  const wasStopped = existsSync(stopped);
  rmSync(stopped, { force: true });
  writeFileSync(started, new Date().toISOString());
  if (wasStopped) return "stopped";
  return seenBefore ? "crashed" : null;
}

/** Called from the SIGTERM handler, before anything else, so a stop from outside is told apart from a crash. */
export function markStopped(dataDir: string) {
  try {
    writeFileSync(path.join(dataDir, STOPPED), new Date().toISOString());
  } catch {
    /* a full or read-only disk: the next start then reads it as a crash, which is the safer guess */
  }
}

/** When the host machine booted (the kernel's btime; a container shares the host's kernel), or null if unreadable. */
export function hostBootAt(statFile = "/proc/stat"): string | null {
  try {
    const m = /^btime (\d+)$/m.exec(readFileSync(statFile, "utf8"));
    return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
  } catch {
    return null;
  }
}
