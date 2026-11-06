// What ran during an event-loop stall (BOS-602). The stall monitor (BOS-432) sees that the loop was blocked
// but not by what. This keeps V8's sampling CPU profiler running at a low rate and, when a stall ends, cuts the
// profile and reports the functions the main thread was in during the stall. Its samples come from a separate
// thread, so they are taken while the loop is blocked, including inside a synchronous native call (attributed to
// the JS function that made it). Combined with the process CPU used during the stall (stall-monitor.ts), that
// separates "our code computed for 2 s" from "the process was made to wait".
//
// Why console.profile and two alternating titles, not Profiler.start/stop: V8 walks the whole heap to log every
// compiled function each time profiling goes from off to on (measured: ~0.75 s on a 1 GB heap, so seconds on the
// live server's 4 GB heap, which would itself be a freeze). Starting the next profile before ending the current
// one keeps profiling on at all times, so only the first start pays that walk (at server start, small heap) and
// each cut costs ~0.2 ms.
// inspector's own console (V8's), not the global one, which test runners and loggers may replace.
import { console as v8Console, Session, type Profiler } from "node:inspector";
import { performance } from "node:perf_hooks";

export type StallProfile = {
  /** Sampled time inside the stall window. Much less than the stall means the whole process was stopped (sampler thread too). */
  sampledMs: number;
  /** Leaf functions by time: where the main thread actually was. `via` is the nearest server-code caller. */
  top: { fn: string; ms: number; via: string | null }[];
  /** Server-code functions by time (the deepest one on each sample's stack). */
  app: { fn: string; ms: number }[];
};

export type LoopProfiler = {
  /** Ends the current profile (a new one is already running) and summarises the samples between two performance.now() times. */
  cut(fromPerf: number, toPerf: number): StallProfile | null;
  /** Ends the current profile without reading it, so its samples don't pile up. */
  rotate(): void;
  stop(): void;
};

const APP = /\/(apps|packages)\/[^/]+\/src\//;

function shortUrl(url: string): string {
  const u = url.replace(/^file:\/\//, "");
  const nm = u.lastIndexOf("/node_modules/");
  if (nm >= 0) return u.slice(nm + "/node_modules/".length);
  const app = u.search(/\/(apps|packages)\//);
  if (app >= 0) return u.slice(app + 1);
  return u.split("/").slice(-2).join("/");
}

function label(f: Profiler.ProfileNode["callFrame"]): string {
  if (!f.url) return f.functionName || "(native)";
  return `${f.functionName || "(anonymous)"} ${shortUrl(f.url)}:${f.lineNumber + 1}`;
}

/** Summarises a profile's samples between two times given in the profile's own clock (µs). Exported for tests. */
export function summariseProfile(p: Profiler.Profile, fromUs: number, toUs: number, keep = 5): StallProfile {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  // not state: locals of one summary, dropped when it returns.
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const leafMs = new Map<string, { ms: number; via: string | null }>();
  const appMs = new Map<string, number>(); // not state: as above
  let sampledUs = 0;
  let t = p.startTime;
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const d = deltas[i] ?? 0;
    t += d;
    if (t < fromUs || t > toUs) continue;
    sampledUs += d;
    const leaf = byId.get(samples[i]!);
    if (!leaf) continue;
    // Nearest server-code frame on the stack, leaf included.
    let app: string | null = null;
    for (let id: number | undefined = leaf.id; id !== undefined; id = parent.get(id)) {
      const f = byId.get(id)!.callFrame;
      if (APP.test(f.url)) {
        app = label(f);
        break;
      }
    }
    const name = label(leaf.callFrame);
    const e = leafMs.get(name) ?? { ms: 0, via: app === name ? null : app };
    e.ms += d / 1000;
    leafMs.set(name, e);
    if (app) appMs.set(app, (appMs.get(app) ?? 0) + d / 1000);
  }
  const round = (ms: number) => Math.round(ms);
  return {
    sampledMs: round(sampledUs / 1000),
    top: [...leafMs.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, keep).map(([fn, e]) => ({ fn, ms: round(e.ms), via: e.via })),
    app: [...appMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, keep).map(([fn, ms]) => ({ fn, ms: round(ms) })),
  };
}

/** Starts the sampler (one sample every `intervalUs`). Null if the inspector is unavailable; the stall monitor then works without profiles. */
export function startLoopProfiler(intervalUs: number): LoopProfiler | null {
  let session: Session;
  try {
    session = new Session();
    session.connect();
  } catch {
    return null;
  }
  const titles = ["bossman-stall-a", "bossman-stall-b"] as const;
  let current = 0;
  let finished: Profiler.Profile | null = null;
  const onFinished = (m: { params: Profiler.ConsoleProfileFinishedEventDataType }) => {
    if (m.params.title === titles[0] || m.params.title === titles[1]) finished = m.params.profile;
  };
  session.on("Profiler.consoleProfileFinished", onFinished);
  session.post("Profiler.enable");
  session.post("Profiler.setSamplingInterval", { interval: intervalUs });
  v8Console.profile(titles[current]);
  let running = true;

  // The inspector delivers the finished profile synchronously on this thread (checked on Node 22).
  const swap = (): { profile: Profiler.Profile | null; at: number } => {
    const next = 1 - current;
    v8Console.profile(titles[next]);
    finished = null;
    const at = performance.now();
    v8Console.profileEnd(titles[current]);
    current = next;
    const profile = finished as Profiler.Profile | null;
    finished = null;
    return { profile, at };
  };

  return {
    cut(fromPerf, toPerf) {
      if (!running) return null;
      const { profile, at } = swap();
      if (!profile) return null;
      // The profile ended at `at` (performance.now() time) and at profile.endTime (its own clock, µs).
      const toUs = (perf: number) => profile.endTime - (at - perf) * 1000;
      return summariseProfile(profile, toUs(fromPerf), toUs(toPerf));
    },
    rotate() {
      if (running) swap();
    },
    stop() {
      if (!running) return;
      running = false;
      v8Console.profileEnd(titles[current]);
      session.off("Profiler.consoleProfileFinished", onFinished);
      session.post("Profiler.disable");
      session.disconnect();
    },
  };
}
