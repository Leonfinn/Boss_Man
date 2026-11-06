// Keeps a core back for the server, database and proxy (BOS-586). Under load the server froze while the host was
// ~90% busy with agent work, so runners are confined to every thread except a few; nothing else is pinned, so the
// server, database and proxy can always run on the reserved ones. Everything is worked out at runtime.
import { readFileSync } from "node:fs";
import os from "node:os";

/** "0-3,8" as [0,1,2,3,8]. Anything else is an error. */
export function parseCpuList(s: string): number[] {
  const out = new Set<number>();
  for (const part of s.trim().split(",").filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Not a CPU list: ${s}`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b < a || b - a > 65536) throw new Error(`Not a CPU list: ${s}`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/** [0,1,2,3,8] as "0-3,8". */
export function formatCpuList(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return parts.join(",");
}

export type CpuSetting = { mode: "auto" } | { mode: "off" } | { mode: "count"; threads: number };

/** BOSSMAN_RESERVED_THREADS: auto (default), off or 0, or a number of threads to keep back. */
export function parseReservedThreads(v: string | undefined): CpuSetting {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "" || t === "auto") return { mode: "auto" };
  if (t === "off" || t === "0") return { mode: "off" };
  if (!/^\d{1,3}$/.test(t)) throw new Error(`BOSSMAN_RESERVED_THREADS should be auto, off or a number of threads, not ${v}`);
  return { mode: "count", threads: Number(t) };
}

/** The threads this host lets containers use: the cgroup cpuset (LXC, limited VMs), else the process affinity, else every thread. */
export function allowedThreads(read: (path: string) => string | null = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } }): number[] {
  for (const p of ["/sys/fs/cgroup/cpuset.cpus.effective", "/sys/fs/cgroup/cpuset/cpuset.effective_cpus", "/sys/fs/cgroup/cpuset/cpuset.cpus"]) {
    const t = read(p)?.trim();
    if (t) try { return parseCpuList(t); } catch { /* try the next source */ }
  }
  const m = /^Cpus_allowed_list:\s*(\S+)/m.exec(read("/proc/self/status") ?? "");
  if (m) try { return parseCpuList(m[1]!); } catch { /* fall through */ }
  return Array.from({ length: os.availableParallelism() }, (_, i) => i);
}

export const MIN_THREADS_FOR_AUTO = 6;
export const AUTO_RESERVED_THREADS = 2;
/** Runners always keep at least this many threads. */
export const MIN_RUNNER_THREADS = 2;

export type CpuPlan = {
  on: boolean;
  /** Threads kept back for the server, database and proxy. */
  reserved: number[];
  /** Threads the runners' containers are confined to (CpusetCpus); empty when off. */
  runnerThreads: number[];
  hostThreads: number;
  /** Plain words: why it is on or off. */
  reason: string;
};

/**
 * Picks the reserved threads: whole cores (SMT siblings together) from the highest thread numbers down, trimmed to the count asked.
 * `siblingsOf` returns a thread's hyperthread siblings (thread_siblings_list), or null when the host doesn't say.
 */
export function planReserve(setting: CpuSetting, threads: number[], siblingsOf: (id: number) => number[] | null = () => null): CpuPlan {
  const base = { reserved: [] as number[], runnerThreads: [] as number[], hostThreads: threads.length };
  if (setting.mode === "off") return { ...base, on: false, reason: "Switched off (BOSSMAN_RESERVED_THREADS)." };
  const n = setting.mode === "auto" ? AUTO_RESERVED_THREADS : setting.threads;
  if (setting.mode === "auto" && threads.length < MIN_THREADS_FOR_AUTO) return { ...base, on: false, reason: `Off: this host has ${threads.length} threads and the automatic reserve needs ${MIN_THREADS_FOR_AUTO} or more.` };
  if (threads.length - n < MIN_RUNNER_THREADS) return { ...base, on: false, reason: `Off: keeping ${n} of ${threads.length} threads back would leave the runners fewer than ${MIN_RUNNER_THREADS}.` };
  const set = new Set(threads);
  const picked: number[] = [];
  const seen = new Set<number>();
  for (const id of [...threads].reverse()) {
    if (picked.length >= n) break;
    if (seen.has(id)) continue;
    const group = [...new Set([id, ...(siblingsOf(id) ?? [])])].filter((t) => set.has(t)).sort((a, b) => b - a);
    for (const g of group) seen.add(g);
    for (const g of group) if (picked.length < n) picked.push(g);
  }
  const reserved = picked.sort((a, b) => a - b);
  const runnerThreads = threads.filter((t) => !reserved.includes(t));
  return { on: true, reserved, runnerThreads, hostThreads: threads.length, reason: `On: threads ${formatCpuList(reserved)} are kept for the server, database and proxy; runners use ${formatCpuList(runnerThreads)}.` };
}

export function siblingsFromSysfs(id: number): number[] | null {
  try {
    return parseCpuList(readFileSync(`/sys/devices/system/cpu/cpu${id}/topology/thread_siblings_list`, "utf8"));
  } catch {
    return null;
  }
}
