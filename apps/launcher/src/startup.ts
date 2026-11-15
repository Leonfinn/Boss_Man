// Start-up helpers for the image install (BOS-974), where the compose file gives the launcher no host paths and no group number.
import { statSync } from "node:fs";
import path from "node:path";
import type { ContainerInfo } from "./docker.js";

/** What process.setgroups & co. need, so a test can pass a fake. */
export type Ids = { getuid(): number; geteuid?(): number; setgroups(g: number[]): void; setgid(g: number): void; setuid(u: number): void };

/**
 * The image install starts the launcher as root with only the SETUID and SETGID capabilities, so it can learn the Docker socket's
 * group by itself (no `stat` on the host, no number in .env). It joins that group, becomes uid/gid 1000 and keeps nothing else.
 * Already uid 1000 (the build install, which uses group_add) = does nothing. Returns what it did, for the log.
 */
export function dropToUnprivileged(socket: string, ids: Ids = { getuid: () => process.getuid!(), geteuid: () => process.geteuid!(), setgroups: (g) => process.setgroups!(g), setgid: (g) => process.setgid!(g), setuid: (u) => process.setuid!(u) }, stat: (p: string) => { gid: number; mode?: number } = statSync, uid = 1000): string {
  if (ids.getuid() !== 0) return "not root; nothing to drop";
  const st = stat(socket);
  const gid = st.gid;
  // The group must be able to read and write the socket; never fall back to staying root (Dougal's note, BOS-1188).
  const problem = socketModeProblem(socket, st);
  if (problem) throw new Error(problem);
  // Group 0 (Docker Desktop) is allowed: uid 1000 with group 0 added is not root. Any other group is joined as an extra group.
  ids.setgroups([gid]);
  ids.setgid(gid === 0 ? 0 : uid);
  ids.setuid(uid);
  const euid = ids.geteuid ? ids.geteuid() : uid;
  if (ids.getuid() !== uid || euid !== uid) throw new Error(`Could not drop to uid ${uid} (now uid ${ids.getuid()}, euid ${euid}); stopping instead of running as root.`);
  return gid === 0 ? `socket group is root (0), running as uid ${uid} with that group` : `dropped to uid ${uid}, socket group ${gid}`;
}

/** A plain-words problem if the socket's group cannot read and write it, else null. Setup and the launcher both use it. */
export function socketModeProblem(socket: string, st: { mode?: number }): string | null {
  if (st.mode === undefined || (st.mode & 0o060) === 0o060) return null;
  return `The Docker socket (${socket}) is not read-write for its group (mode ${(st.mode & 0o777).toString(8)}), so the launcher cannot use it as a non-root user. Allow the socket's group to read and write it.`;
}

/**
 * Remembers which group the Docker socket had at this start in `file`, and says so when it differs from the last start
 * (for example after a Docker reinstall), so a "permission denied" later has a visible cause. Returns the log line, or null.
 */
export function noteSocketGroup(file: string, gid: number, read: (f: string) => string | null, write: (f: string, body: string) => void): string | null {
  const before = read(file)?.trim();
  write(file, `${gid}\n`);
  if (before === undefined || before === "" || before === String(gid)) return null;
  return `socket group changed from ${before} to ${gid} since the last start; the launcher joins the group it sees now`;
}

/**
 * Where a folder mounted into this container lives on the Docker host: the Source of the mount whose Destination is `dest`.
 * Runners are started by the host's Docker, so their Binds must use these paths, not the ones inside this container.
 */
export function hostPathOfMount(self: ContainerInfo | null, dest: string): string {
  const d = path.posix.normalize(dest).replace(/\/+$/, "") || "/";
  const m = (self?.Mounts ?? []).find((x) => x.Destination && (path.posix.normalize(x.Destination).replace(/\/+$/, "") || "/") === d);
  if (!m?.Source || !path.isAbsolute(m.Source)) throw new Error(`Could not find where ${dest} is on the Docker host (this container has no mount there). Set BOSSMAN_DATA_HOST to that folder.`);
  return m.Source;
}
