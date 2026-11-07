import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// Compose files use `<<:` merge keys.
const parse = (text: string) => parseYaml(text, { merge: true, logLevel: "error" });

// BOS-395: a container with no memory limit can take the whole host (BOS-392). Keep the limits in compose.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type Service = { cpu_shares?: number; mem_limit?: string | number; oom_score_adj?: number; profiles?: string[]; command?: string[] };
const services = (file: string): Record<string, Service> => parse(readFileSync(path.join(root, file), "utf8")).services;
// Build-only or parked services that never run a process of their own.
const NOT_RUN = new Set(["netguard"]);

describe("compose memory limits", () => {
  for (const file of ["docker-compose.yml", "deploy/truenas-bluegreen.yml", "deploy/tool-servers.yml", "deploy/penpot.yml", "deploy/ntfy.yml", "deploy/tailscale.yml"]) {
    it(`${file}: every service has a mem_limit`, () => {
      const missing = Object.entries(services(file))
        .filter(([name, s]) => !NOT_RUN.has(name) && s.mem_limit === undefined)
        // Blue/green parks the single server (profiles overridden) and gives the colours the limit through an anchor.
        .map(([name]) => name);
      // truenas-bluegreen.yml's `server` is parked and `runner-app-co` is inherited from docker-compose.yml.
      // Overrides of services docker-compose.yml already limits (tailscale.yml adds only an env var to `server`).
      const allowed = file.endsWith("truenas-bluegreen.yml") ? ["server", "runner-app-co"] : file.endsWith("tailscale.yml") ? ["server"] : [];
      expect(missing.filter((n) => !allowed.includes(n)), `no mem_limit in ${file}`).toEqual([]);
    });
  }

  it("the runner template carries a limit, no swap and a high OOM score", () => {
    const text = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
    const runner = parse(text)["x-runner"];
    expect(String(runner.mem_limit)).toContain("BOSSMAN_RUNNER_MEMORY");
    expect(String(runner.memswap_limit)).toContain("BOSSMAN_RUNNER_MEMORY");
    expect(runner.oom_score_adj).toBeGreaterThan(0);
  });

  it("server and database are uncapped unless the owner sets a limit (the server uses 10-13 GiB, BOS-405)", () => {
    const bg = services("deploy/truenas-bluegreen.yml");
    const main = services("docker-compose.yml");
    for (const [n, s] of [["db", main.db], ["server", main.server], ["server-blue", bg["server-blue"]], ["server-green", bg["server-green"]]] as const) {
      expect(String(s!.mem_limit), n).toMatch(/^\$\{BOSSMAN_(SERVER|DB)_MEMORY:-0\}$/);
    }
  });

  it("every server process caps its JS heap from BOSSMAN_SERVER_HEAP_MB, default 1536 MiB (BOS-410)", () => {
    const bg = services("deploy/truenas-bluegreen.yml");
    const main = services("docker-compose.yml");
    for (const [n, s] of [["server", main.server], ["server-blue", bg["server-blue"]], ["server-green", bg["server-green"]]] as const) {
      expect((s as { environment?: Record<string, string> }).environment?.NODE_OPTIONS, n).toBe("--max-old-space-size=${BOSSMAN_SERVER_HEAP_MB:-1536}");
    }
  });

  it("server, database and proxy are protected from the OOM killer", () => {
    const main = services("docker-compose.yml");
    expect(main.db!.oom_score_adj).toBeLessThan(0);
    expect(main.server!.oom_score_adj).toBeLessThan(0);
    const bg = services("deploy/truenas-bluegreen.yml");
    for (const n of ["server-blue", "server-green", "proxy"]) expect(bg[n]!.oom_score_adj, n).toBeLessThan(0);
    expect(bg.proxy!.oom_score_adj).toBeLessThanOrEqual(bg["server-blue"]!.oom_score_adj!);
  });

  // BOS-412: priority, not a cap. Runners get a lower CPU weight than the server, database and proxy; the hard cap is opt-in.
  it("runners have a lower CPU weight than the server, database and proxy, and no cap by default", () => {
    const main = services("docker-compose.yml");
    const runner = parse(readFileSync(path.join(root, "docker-compose.yml"), "utf8"))["x-runner"];
    expect(String(runner.cpu_shares)).toContain("BOSSMAN_RUNNER_CPU_SHARES:-512");
    expect(String(runner.cpus)).toMatch(/^\$\{BOSSMAN_RUNNER_CPUS:-0\}$/);
    const bg = services("deploy/truenas-bluegreen.yml");
    // Unset = Docker default 1024, above the runner weight; only the proxy sets a value (2048). Setting 1024 on db/server would change their config for nothing.
    for (const [n, s] of [["db", main.db], ["server", main.server], ["server-blue", bg["server-blue"]], ["server-green", bg["server-green"]]] as const) {
      expect(s!.cpu_shares ?? 1024, n).toBeGreaterThan(512);
    }
    expect(bg.proxy!.cpu_shares).toBe(2048);
    // The launcher gets the same two settings, so both places a runner is defined agree.
    const launcherEnv = parse(readFileSync(path.join(root, "docker-compose.yml"), "utf8")).services.launcher.environment;
    expect(launcherEnv.BOSSMAN_RUNNER_CPU_SHARES).toContain("BOSSMAN_RUNNER_CPU_SHARES:-512");
    expect(launcherEnv.BOSSMAN_RUNNER_CPUS).toContain("BOSSMAN_RUNNER_CPUS");
    // The reserved core (BOS-586) is off unless the owner turns it on; the launcher works out the threads at runtime.
    expect(launcherEnv.BOSSMAN_RESERVED_THREADS).toContain("BOSSMAN_RESERVED_THREADS:-off");
    // The compose runner passes the check-slot setting on too (BOS-542); empty by default, so an unset setting leaves a hand-made proof file alone.
    expect(String(runner.environment.BOSSMAN_CHECK_SLOTS)).toBe("${BOSSMAN_CHECK_SLOTS:-}");
  });

  // BOS-602: compose passes only the variables it lists, so the profiler's off switch must be listed for every server.
  it("the stall profiler's off switch reaches the single server and both blue/green colours", () => {
    const main = services("docker-compose.yml") as Record<string, Service & { environment?: Record<string, string> }>;
    const bg = services("deploy/truenas-bluegreen.yml") as typeof main;
    for (const [n, s] of [["server", main.server], ["server-blue", bg["server-blue"]], ["server-green", bg["server-green"]]] as const) {
      expect(s!.environment?.BOSSMAN_STALL_PROFILE, n).toBe("${BOSSMAN_STALL_PROFILE:-}");
    }
  });

  it("tool servers are the first to be killed", () => {
    for (const [name, s] of Object.entries(services("deploy/tool-servers.yml"))) expect(s.oom_score_adj, name).toBeGreaterThan(0);
  });
});
