// What the memory outside the JS heap is made of (BOS-410 step 2). On 5 Nov the live server held
// 15 GiB with a ~100 MiB heap and almost no Buffers (nativeOther 15.0 GiB in 52 min), so the
// step-1 figures can't say whose it is. These cheap readings split it:
// - threads: a growing count means threads (each with its own malloc arena and stack) are leaking.
// - smaps by kind: glibc gives each thread arena a 64 MiB-aligned region; the main thread grows
//   [heap] (brk); big single malloc/mmap blocks and V8's own pages are other anonymous regions.
//   Arena-like growth = native malloc on other threads (libuv pool, a worker, a loader thread);
//   [heap] growth = malloc on the main thread; one huge region = one huge allocation.
// - V8: its own malloc (compiler zones), and native contexts (vm contexts, workers) that pile up.
// - handles: open sockets, timers, fs requests and so on, by type.
// Linux only; elsewhere the /proc parts are left out. Read-only, once per memory sample.
import { readFile } from "node:fs/promises";
import v8 from "node:v8";

const KiB_PER_MiB = 1024;
const ARENA_ALIGN = 64 * 1024 * 1024; // glibc HEAP_MAX_SIZE on 64-bit

export type NativeDetail = Record<string, number>;

/** VmRSS, RssAnon, RssFile, RssShmem, VmHWM (MiB) and Threads from /proc/<pid>/status. */
export function parseStatus(text: string): NativeDetail {
  const out: NativeDetail = {};
  const wanted: Record<string, string> = { VmRSS: "vmRss", RssAnon: "rssAnon", RssFile: "rssFile", RssShmem: "rssShmem", VmHWM: "rssPeak", Threads: "threads" };
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    const key = m && wanted[m[1]!];
    if (!key) continue;
    const n = Number(m[2]);
    out[key] = key === "threads" ? n : Math.round(n / KiB_PER_MiB);
  }
  return out;
}

/** Resident memory (MiB) by kind of mapping, from /proc/<pid>/smaps. */
export function parseSmaps(text: string): NativeDetail {
  let brk = 0, arena = 0, otherAnon = 0, stack = 0, file = 0, arenas = 0, maps = 0, largest = 0;
  let kind: "brk" | "arena" | "anon" | "stack" | "file" = "file";
  let sizeKiB = 0;
  for (const line of text.split("\n")) {
    const head = /^([0-9a-f]+)-([0-9a-f]+)\s+\S+\s+\S+\s+\S+\s+(\d+)\s*(.*)$/.exec(line);
    if (head) {
      maps++;
      const start = parseInt(head[1]!, 16);
      sizeKiB = (parseInt(head[2]!, 16) - start) / 1024;
      const path = head[4]!.trim();
      if (path === "[heap]") kind = "brk";
      else if (path.startsWith("[stack")) kind = "stack";
      else if (path === "" || path.startsWith("[anon")) {
        // A thread arena starts on a 64 MiB boundary and is at most 64 MiB; V8 and big mallocs rarely both.
        const arenaLike = head[3] === "0" && start % ARENA_ALIGN === 0 && sizeKiB <= ARENA_ALIGN / 1024;
        kind = arenaLike ? "arena" : "anon";
        if (arenaLike) arenas++;
      } else kind = path.startsWith("[") ? "anon" : "file";
      continue;
    }
    const rss = /^Rss:\s+(\d+)/.exec(line);
    if (!rss) continue;
    const kib = Number(rss[1]);
    if (kind === "brk") brk += kib;
    else if (kind === "arena") arena += kib;
    else if (kind === "stack") stack += kib;
    else if (kind === "anon") { otherAnon += kib; largest = Math.max(largest, kib); }
    else file += kib;
  }
  const mib = (k: number) => Math.round(k / KiB_PER_MiB);
  return { mapBrkHeap: mib(brk), mapArenas: mib(arena), arenas, mapOtherAnon: mib(otherAnon), mapLargestAnon: mib(largest), mapStacks: mib(stack), mapFile: mib(file), maps };
}

/** V8's own malloc and context counts, and open handles by type (handle_<Type>). */
export function v8AndHandles(): NativeDetail {
  const h = v8.getHeapStatistics();
  const out: NativeDetail = {
    v8Malloced: Math.round(h.malloced_memory / 1024 / 1024),
    v8MallocedPeak: Math.round(h.peak_malloced_memory / 1024 / 1024),
    nativeContexts: h.number_of_native_contexts,
    detachedContexts: h.number_of_detached_contexts,
  };
  for (const type of process.getActiveResourcesInfo()) out[`handle_${type}`] = (out[`handle_${type}`] ?? 0) + 1;
  return out;
}

/** All of the above for this process. Async file reads, so a large smaps is walked off the main thread. */
export async function readNativeDetail(proc = "/proc/self"): Promise<NativeDetail> {
  const [status, smaps] = await Promise.all([readFile(`${proc}/status`, "utf8").catch(() => ""), readFile(`${proc}/smaps`, "utf8").catch(() => "")]);
  return { ...parseStatus(status), ...(smaps ? parseSmaps(smaps) : {}), ...v8AndHandles() };
}
