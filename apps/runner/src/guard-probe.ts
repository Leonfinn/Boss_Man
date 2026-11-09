// The runner proves its own network guard (DR-049 point 2). On a Docker network the default gateway is
// always a private address, and the guard refuses private addresses at once ("No route to host",
// EHOSTUNREACH). So a TCP connect to the gateway that fails fast with EHOSTUNREACH means the guard is on;
// a connect that succeeds, times out or is refused (ECONNREFUSED) means nothing is stopping the runner.
import { readFileSync } from "node:fs";
import net from "node:net";
import type { GuardReport } from "@boss-man/shared";

/** Default gateway from the contents of /proc/net/route (little-endian hex), lowest metric first; null if none. */
export function defaultGateway(route: string): string | null {
  let best: { metric: number; ip: string } | null = null;
  for (const line of route.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[1] !== "00000000" || f[7] !== "00000000") continue;
    const flags = parseInt(f[3]!, 16);
    if (!(flags & 1) || !(flags & 2)) continue; // up and a gateway route
    const g = parseInt(f[2]!, 16);
    if (!Number.isFinite(g) || g === 0) continue;
    const ip = [g & 255, (g >>> 8) & 255, (g >>> 16) & 255, (g >>> 24) & 255].join(".");
    const metric = parseInt(f[6]!, 10) || 0;
    if (!best || metric < best.metric) best = { metric, ip };
  }
  return best?.ip ?? null;
}

/** One connect attempt, resolved with what happened. Never rejects. */
export function tryConnect(host: string, port: number, timeoutMs: number): Promise<{ outcome: "connected" | "timeout" | "error"; errno: string | null; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    const done = (outcome: "connected" | "timeout" | "error", errno: string | null) => {
      sock.destroy();
      resolve({ outcome, errno, ms: Date.now() - started });
    };
    sock.setTimeout(timeoutMs, () => done("timeout", null));
    sock.once("connect", () => done("connected", null));
    sock.once("error", (err) => done("error", (err as NodeJS.ErrnoException).code ?? err.message));
  });
}

/** Classifies one connect: only an immediate EHOSTUNREACH is the guard's refusal. */
export function classify(r: { outcome: string; errno: string | null; ms: number }): GuardReport["state"] {
  // Under 1 s: an unguarded host whose gateway doesn't answer ARP also gives EHOSTUNREACH, but after about 3 s.
  return r.outcome === "error" && r.errno === "EHOSTUNREACH" && r.ms < 1000 ? "on" : "absent";
}

export async function probeGuard(opts: { routeFile?: string; port?: number; timeoutMs?: number } = {}): Promise<GuardReport> {
  let gateway: string | null = null;
  try {
    gateway = defaultGateway(readFileSync(opts.routeFile ?? "/proc/net/route", "utf8"));
  } catch {
    gateway = null;
  }
  if (!gateway) return { state: "absent", reason: "no default gateway found", errno: null, ms: 0 };
  const r = await tryConnect(gateway, opts.port ?? 9, opts.timeoutMs ?? 3000);
  const state = classify(r);
  const reason = state === "on" ? "connect to the gateway was refused at once (EHOSTUNREACH)" : r.outcome === "connected" ? "connect to the gateway succeeded" : r.outcome === "timeout" ? "connect to the gateway timed out, so it was not refused" : `connect to the gateway failed with ${r.errno}`;
  return { state, reason, errno: r.errno, ms: r.ms };
}
