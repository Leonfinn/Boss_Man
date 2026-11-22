// BOS-2217: the memory this machine really has for its checks, told to the server in hello so the worker form can warn
// when "checks at once × memory per check" is more than that. Works on any Docker host: the container's own limit
// (cgroup v2 memory.max, or cgroup v1 memory.limit_in_bytes) when there is one, otherwise the host's memory.
import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { CHECK_HOST_OVERHEAD_MB, CHECK_PEAK_MB } from "@boss-man/shared";

const CGROUP_FILES = ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"];

type Read = (file: string) => string | null;
const readFile: Read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};

/** The usable memory in MB: the smaller of the cgroup limit (when set; "max" and values above 2^50 mean unlimited) and the host's memory. */
export function machineMemoryMb(read: Read = readFile, hostBytes: number = totalmem()): number {
  let bytes = hostBytes;
  for (const f of CGROUP_FILES) {
    const raw = read(f);
    if (raw === null) continue;
    const limit = Number(raw.trim());
    if (Number.isFinite(limit) && limit > 0 && limit < 2 ** 50) bytes = Math.min(bytes, limit);
    break;
  }
  return Math.max(1, Math.floor(bytes / 1024 ** 2));
}

/** The start-up warning when `slots` full checks at once need more than the machine has, or null. Uses today's measured peak. */
export function startupMemoryWarning(slots: number, memoryMb: number): string | null {
  const needMb = slots * CHECK_PEAK_MB + CHECK_HOST_OVERHEAD_MB;
  if (memoryMb >= needMb) return null;
  const gb = (mb: number) => Math.round(mb / 102.4) / 10;
  return `warning: this machine has ${gb(memoryMb)} GB for checks but ${slots} full check${slots === 1 ? "" : "s"} at once need about ${gb(needMb)} GB (each peaks near ${gb(CHECK_PEAK_MB)} GB); lower the checks at once or give it more memory, or checks may be OOM-killed`;
}
