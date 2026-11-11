// Start-up helpers for the image install (BOS-974), where the compose file gives the launcher no host paths and no group number.
import { statSync } from "node:fs";
import path from "node:path";
import type { ContainerInfo } from "./docker.js";

/** What process.setgroups & co. need, so a test can pass a fake. */
export type Ids = { getuid(): number; setgroups(g: number[]): void; setgid(g: number): void; setuid(u: number): void };

/**
 * The image install starts the launcher as root with only the SETUID and SETGID capabilities, so it can learn the Docker socket's
 * group by itself (no `stat` on the host, no number in .env). It joins that group, becomes uid/gid 1000 and keeps nothing else.
 * Already uid 1000 (the build install, which uses group_add) = does nothing. Returns what it did, for the log.
 */
export function dropToUnprivileged(socket: string, ids: Ids = { getuid: () => process.getuid!(), setgroups: (g) => process.setgroups!(g), setgid: (g) => process.setgid!(g), setuid: (u) => process.setuid!(u) }, stat: (p: string) => { gid: number } = statSync, uid = 1000): string {
  if (ids.getuid() !== 0) return "not root; nothing to drop";
  const gid = stat(socket).gid;
  // Group 0 would give root's group back; the socket is then reachable by uid 1000 only if "other" may write, which is up to the host.
  ids.setgroups(gid === 0 ? [] : [gid]);
  ids.setgid(uid);
  ids.setuid(uid);
  return `dropped to uid ${uid}, socket group ${gid}`;
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
