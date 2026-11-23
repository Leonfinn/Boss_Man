// Start-up helpers (design section 10: the Docker socket's group is root on Docker Desktop).
// The updater starts as root with only SETUID and SETGID, learns the socket's group, joins it, becomes uid 1000 and keeps nothing
// else. Group 0 (Docker Desktop) is allowed: uid 1000 with group 0 added is not root, and the image test proves group 0 can write
// nothing the updater ships. If the drop does not end exactly at uid 1000, it stops rather than run as root.
import { readFileSync, statSync } from "node:fs";
import { UpdaterError } from "./config.js";

export type Ids = { getuid(): number; geteuid?(): number; setgroups(g: number[]): void; setgid(g: number): void; setuid(u: number): void };

const realIds = (): Ids => ({ getuid: () => process.getuid!(), geteuid: () => process.geteuid!(), setgroups: (g) => process.setgroups!(g), setgid: (g) => process.setgid!(g), setuid: (u) => process.setuid!(u) });

/** A plain-words problem if the socket's group cannot read and write it, else null. */
export function socketModeProblem(socket: string, st: { mode?: number }): string | null {
  if (st.mode === undefined || (st.mode & 0o060) === 0o060) return null;
  return `The Docker socket (${socket}) is not read-write for its group (mode ${(st.mode & 0o777).toString(8)}), so the updater cannot use it as a non-root user. Allow the socket's group to read and write it.`;
}

export function dropToUnprivileged(socket: string, ids: Ids = realIds(), stat: (p: string) => { gid: number; mode?: number } = statSync, uid = 1000): string {
  if (ids.getuid() !== 0) return "not root; nothing to drop";
  const st = stat(socket);
  const problem = socketModeProblem(socket, st);
  if (problem) throw new UpdaterError("socket_mode", problem);
  ids.setgroups([st.gid]);
  ids.setgid(st.gid === 0 ? 0 : uid);
  ids.setuid(uid);
  const euid = ids.geteuid ? ids.geteuid() : uid;
  if (ids.getuid() !== uid || euid !== uid) throw new UpdaterError("drop_failed", `Could not drop to uid ${uid} (now uid ${ids.getuid()}, euid ${euid}); stopping instead of running as root.`);
  return st.gid === 0 ? `socket group is root (0), running as uid ${uid} with that group` : `dropped to uid ${uid}, socket group ${st.gid}`;
}

/** The key the server presents, from the named volume. Short or missing = a plain refusal to start. */
export function readKey(file: string, read: (f: string) => string = (f) => readFileSync(f, "utf8")): string {
  let text: string;
  try {
    text = read(file).trim();
  } catch {
    throw new UpdaterError("key_missing", `The updater's key file (${file}) is missing, so it will not start. Run the setup step again.`);
  }
  if (text.length < 32) throw new UpdaterError("key_short", `The updater's key file (${file}) is too short to be a key, so it will not start. Run the setup step again.`);
  return text;
}
