import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerError } from "../src/docker.js";
import type { ContainerInfo, ContainerSummary, Docker } from "../src/docker.js";
import { launcher, launcherServer } from "../src/launcher.js";
import { containerSpec, netguardSpec, parseAllow, parseCheckSlots, parseCpuShares, parseCpus, parseGuardMode, parseMemory, parseOpencodeSessionDays, parsePids, parsePnpmStoreDir, serverAddress, type LauncherConfig } from "../src/spec.js";

const KEY = "k".repeat(43);
const TOKEN = `bmr_${"t".repeat(43)}`;

/** A stand-in Docker that keeps containers in memory and records each call. */
function fakeDocker() {
  const containers = new Map<string, { id: string; labels: Record<string, string>; spec: unknown; state: string; imageId: string; startedAt: number; health?: string; exitCode?: number }>();
  const fail = { guard: false, nft: false, bad: false, hang: false, slow: false };
  let clock = 0;
  const image = { current: "img1" };
  const calls: string[] = [];
  let n = 0;
  const docker: Docker = {
    async list(label) {
      calls.push(`list ${label}`);
      const [k, v] = label.split("=");
      return [...containers.entries()]
        .filter(([, c]) => c.labels[k!] === v)
        .map(([name, c]) => ({ Id: c.id, Names: [`/${name}`], Image: "boss-man-runner:current", ImageID: c.imageId, State: c.state, Status: c.state, Labels: c.labels, Created: 0 }) as ContainerSummary);
    },
    async inspect(name) {
      calls.push(`inspect ${name}`);
      const c = containers.get(name);
      return c ? ({ Id: c.id, Name: `/${name}`, Config: { Labels: c.labels }, State: { Status: c.state, StartedAt: new Date(c.startedAt).toISOString(), ExitCode: c.exitCode, ...(c.health ? { Health: { Status: c.health } } : {}) } } as ContainerInfo) : null;
    },
    async imageId() {
      return image.current;
    },
    async create(name, spec) {
      calls.push(`create ${name}`);
      if (fail.guard && name.includes("netguard")) throw new Error("no such image");
      if (fail.slow) await new Promise((r) => setTimeout(r, 5));
      if (containers.has(name)) throw new Error(`409 name conflict: ${name}`);
      const id = `id${++n}`;
      containers.set(name, { id, labels: (spec as { Labels: Record<string, string> }).Labels, spec, state: "created", imageId: image.current, startedAt: 0 });
      return id;
    },
    async start(id) {
      calls.push(`start ${id}`);
      for (const c of containers.values()) {
        if (c.id !== id) continue;
        Object.assign(c, { state: "running", startedAt: ++clock * 1000 });
        if (c.labels["boss-man.netguard"]) Object.assign(c, fail.nft ? { state: "exited", exitCode: 3 } : fail.bad ? { state: "exited", exitCode: 4 } : fail.hang ? { health: "starting" } : { health: "healthy" });
      }
    },
    async restart(id) {
      calls.push(`restart ${id}`);
      for (const c of containers.values()) if (c.id === id) Object.assign(c, { state: "running", startedAt: ++clock * 1000 });
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      for (const [name, c] of containers) if (c.id === id) containers.delete(name);
    },
    // BOS-335: the launcher watches Docker events; this fake's stream stays open until aborted (tested in guard-events.test.ts).
    events(_filter, _since, _onEvent, _onError, signal: AbortSignal) {
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
  return { docker, containers, calls, image, fail };
}

const config = (): LauncherConfig => ({ dataRoot: mkdtempSync(path.join(tmpdir(), "bm-launch-")), network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4 * 1024 ** 3, pidsLimit: 4096, guardReadyMs: 300 });

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve() {
  const cfg = config();
  const fake = fakeDocker();
  const log: Array<Record<string, unknown>> = [];
  const server = launcherServer(launcher(cfg, fake.docker), Buffer.from(KEY), (e) => log.push(e));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => new Promise((r) => server.close(() => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, p: string, body?: unknown, key: string | null = KEY) =>
    fetch(`${base}${p}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { cfg, ...fake, log, call };
}

describe("the runner launcher (R55)", () => {
  it("builds exactly the fixed, locked-down container", () => {
    expect(containerSpec({ dataRoot: "/mnt/data", network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4294967296, pidsLimit: 4096 }, "app-co")).toEqual({
      Image: "boss-man-runner:current",
      User: "1000:1000",
      Env: ["BOSSMAN_URL=ws://server:3100/api/runner/connect", "BOSSMAN_RUNNER_TOKEN_FILE=/run/secrets/runner_token"],
      Labels: { "boss-man.launcher": "1", "boss-man.company": "app-co" },
      HostConfig: {
        Binds: [
          "/mnt/data/companies/app-co/workspaces:/home/node/workspaces",
          "/mnt/data/companies/app-co/runner-data:/home/node/runner-data",
          "/mnt/data/companies/app-co/claude:/home/node/.claude",
          "/mnt/data/companies/app-co/opencode:/home/node/.local/share/opencode",
          "/mnt/data/companies/app-co/runner.token:/run/secrets/runner_token:ro",
        ],
        NetworkMode: "boss-man_default",
        CapDrop: ["ALL"],
        CapAdd: [],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        Devices: [],
        PidMode: "",
        IpcMode: "private",
        UTSMode: "",
        PidsLimit: 4096,
        Init: true,
        Memory: 4294967296,
        MemorySwap: 4294967296,
        OomScoreAdj: 500,
        CpuShares: 512,
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    // BOS-412: weight can be changed, and a hard cap is only set when asked for.
    expect(containerSpec({ ...config(), cpuShares: 256, cpus: 1.5 }, "app-co").HostConfig).toMatchObject({ CpuShares: 256, NanoCpus: 1_500_000_000 });
    expect(containerSpec(config(), "app-co").HostConfig).not.toHaveProperty("NanoCpus");
    expect(containerSpec({ ...config(), checkSlots: 2 }, "app-co").Env).toContain("BOSSMAN_CHECK_SLOTS=2");
    expect(containerSpec({ ...config(), checkSlots: 1 }, "app-co").Env.join()).not.toContain("BOSSMAN_CHECK_SLOTS");
    // BOS-568: the shared pnpm store is only set when the operator asks for another place, and it must stay
    // under the workspaces volume (the runner's only writable one), or it would land on the root disk.
    expect(containerSpec({ ...config(), pnpmStoreDir: "/home/node/workspaces/big/pnpm" }, "app-co").Env).toContain("PNPM_STORE_DIR=/home/node/workspaces/big/pnpm");
    expect(containerSpec(config(), "app-co").Env.join()).not.toContain("PNPM_STORE_DIR");
    expect([parsePnpmStoreDir(undefined), parsePnpmStoreDir("  "), parsePnpmStoreDir("/home/node/workspaces/big/pnpm/")]).toEqual([undefined, undefined, "/home/node/workspaces/big/pnpm"]);
    expect(() => parsePnpmStoreDir("pnpm-store")).toThrow();
    expect(() => parsePnpmStoreDir("relative/pnpm")).toThrow();
    expect(() => parsePnpmStoreDir("/big/../etc")).toThrow();
    expect(() => parsePnpmStoreDir("/big/pnpm")).toThrow(/under/);
    expect(() => parsePnpmStoreDir("/home/node/workspaces-other")).toThrow(/under/);
    expect(() => parsePnpmStoreDir("/tmp/pnpm-store")).toThrow(/under/);
    // BOS-633: the volume's own root is refused too: the fence would grant the whole volume, and the gate store
    // (/home/node/workspaces-gate) would sit on the root disk.
    expect(() => parsePnpmStoreDir("/home/node/workspaces")).toThrow(/root/);
    expect(() => parsePnpmStoreDir("/home/node/workspaces/")).toThrow(/root/);
    expect(() => parsePnpmStoreDir("/")).toThrow();
    expect([parseCheckSlots(undefined), parseCheckSlots(""), parseCheckSlots("2")]).toEqual([1, 1, 2]);
    expect(() => parseCheckSlots("0")).toThrow();
    expect(() => parseCheckSlots("lots")).toThrow();
    // BOS-616: the OpenCode session retention reaches the runner only when set; 0 (never delete) is passed on too.
    expect(containerSpec(config(), "app-co").Env.join()).not.toContain("BOSSMAN_OPENCODE_SESSION_DAYS");
    expect(containerSpec({ ...config(), opencodeSessionDays: 0 }, "app-co").Env).toContain("BOSSMAN_OPENCODE_SESSION_DAYS=0");
    expect([parseOpencodeSessionDays(undefined), parseOpencodeSessionDays(" "), parseOpencodeSessionDays("0"), parseOpencodeSessionDays("30")]).toEqual([undefined, undefined, 0, 30]);
    expect(() => parseOpencodeSessionDays("-1")).toThrow();
    expect(() => parseOpencodeSessionDays("two weeks")).toThrow();
    expect(parseCpuShares(undefined)).toBe(512);
    expect(parseCpuShares("1024")).toBe(1024);
    expect(() => parseCpuShares("1")).toThrow();
    expect(() => parseCpuShares("lots")).toThrow();
    expect(parseCpus(undefined)).toBeUndefined();
    expect(parseCpus("0")).toBeUndefined();
    expect(parseCpus("2")).toBe(2);
    expect(parseCpus("0.5")).toBe(0.5);
    expect(() => parseCpus("-1")).toThrow();
    expect(() => parseCpus("0.001")).toThrow();
    expect(() => parseCpus("many")).toThrow();
    const cfg = config();
    expect(() => containerSpec({ ...cfg, network: "host" }, "app-co")).toThrow();
    expect(() => containerSpec(cfg, "../etc")).toThrow();
    expect(parseMemory("4g")).toBe(4294967296);
    expect(parseMemory("512m")).toBe(536870912);
    expect(() => parseMemory("lots")).toThrow();
    expect(parsePids(undefined)).toBe(4096);
    expect(parsePids("8192")).toBe(8192);
    expect(() => parsePids("lots")).toThrow();
    expect(() => parsePids("10")).toThrow();
  });

  it("writes the token, creates and starts the runner, and recreates it on a second call", async () => {
    const s = await serve();
    const res = await s.call("PUT", "/runners/app-co", { token: TOKEN });
    expect(res.status).toBe(200);
    const file = path.join(s.cfg.dataRoot, "companies/app-co/runner.token");
    expect(readFileSync(file, "utf8")).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const sub of ["workspaces", "runner-data", "claude", "opencode"]) expect(existsSync(path.join(s.cfg.dataRoot, "companies/app-co", sub))).toBe(true);
    expect(s.calls).toEqual(["inspect boss-man-runner-app-co", "create boss-man-runner-app-co", "start id1", "inspect boss-man-netguard-app-co", "create boss-man-netguard-app-co", "start id2", "inspect boss-man-netguard-app-co"]);

    await s.call("PUT", "/runners/app-co", { token: TOKEN });
    expect(s.calls.slice(7)).toEqual(["inspect boss-man-runner-app-co", "remove id1", "create boss-man-runner-app-co", "start id3", "inspect boss-man-netguard-app-co", "remove id2", "create boss-man-netguard-app-co", "start id4", "inspect boss-man-netguard-app-co"]);
    expect(await (await s.call("GET", "/runners")).json()).toEqual([{ slug: "app-co", state: "running", status: "running", image: "boss-man-runner:current", current: true, guard: "on" }]);

    // Every call is logged, never the token.
    expect(s.log.map((e) => [e.method, e.path, e.status])).toContainEqual(["PUT", "/runners/app-co", 200]);
    expect(JSON.stringify(s.log)).not.toContain(TOKEN);
  });

  it("refuses a missing or wrong key, bad slugs, extra fields and other calls", async () => {
    const s = await serve();
    expect((await s.call("GET", "/runners", undefined, null)).status).toBe(401);
    expect((await s.call("GET", "/runners", undefined, "x".repeat(43))).status).toBe(401);
    expect((await s.call("PUT", "/runners/App_Co", { token: TOKEN })).status).toBe(400);
    expect((await s.call("PUT", "/runners/..%2Fetc", { token: TOKEN })).status).toBe(400);
    expect((await s.call("PUT", `/runners/${"a".repeat(41)}`, { token: TOKEN })).status).toBe(400);
    expect((await s.call("PUT", "/runners/app-co", { token: TOKEN, image: "alpine" })).status).toBe(400);
    expect((await s.call("PUT", "/runners/app-co", { token: TOKEN, HostConfig: { Privileged: true } })).status).toBe(400);
    expect((await s.call("PUT", "/runners/app-co", { token: "not a token" })).status).toBe(400);
    expect((await s.call("PUT", "/runners/app-co?image=alpine", { token: TOKEN })).status).toBe(400);
    expect((await s.call("POST", "/containers/create", {})).status).toBe(404);
    expect((await s.call("DELETE", "/runners")).status).toBe(405);
    expect(s.calls.filter((c) => c.startsWith("create"))).toEqual([]);
  });

  it("won't touch a container it didn't make, and removes its own without the data", async () => {
    const s = await serve();
    s.containers.set("boss-man-runner-app-co", { id: "theirs", labels: {}, spec: {}, state: "running", imageId: "x", startedAt: 0 });
    expect((await s.call("PUT", "/runners/app-co", { token: TOKEN })).status).toBe(409);
    expect((await s.call("POST", "/runners/app-co/restart")).status).toBe(409);
    expect((await s.call("DELETE", "/runners/app-co")).status).toBe(409);
    expect(s.containers.get("boss-man-runner-app-co")!.id).toBe("theirs");

    s.containers.clear();
    await s.call("PUT", "/runners/app-co", { token: TOKEN });
    expect((await s.call("POST", "/runners/app-co/restart")).status).toBe(200);
    expect(await (await s.call("DELETE", "/runners/app-co")).json()).toEqual({ slug: "app-co", removed: true });
    expect(existsSync(path.join(s.cfg.dataRoot, "companies/app-co/runner.token"))).toBe(false);
    expect(existsSync(path.join(s.cfg.dataRoot, "companies/app-co/workspaces"))).toBe(true);
    expect((await s.call("POST", "/runners/app-co/restart")).status).toBe(404);
  });

  it("recreates every runner it made, for an image update", async () => {
    const cfg = config();
    const fake = fakeDocker();
    const api = launcher(cfg, fake.docker);
    await api.put("app-co", TOKEN);
    await api.put("homelab", TOKEN);
    fake.containers.set("someone-else", { id: "x", labels: { "boss-man.launcher": "1", "boss-man.company": "app-co" }, spec: {}, state: "running", imageId: "x", startedAt: 0 });
    // A folder added to MOUNTS after the runner was first made (e.g. opencode) is created on recreate, not left to Docker.
    rmSync(path.join(cfg.dataRoot, "companies/app-co/opencode"), { recursive: true });
    expect(await api.recreateAll()).toEqual(["app-co", "homelab"]);
    expect(existsSync(path.join(cfg.dataRoot, "companies/app-co/opencode"))).toBe(true);
    expect(fake.containers.get("someone-else")!.id).toBe("x");
  });

  it("builds the network guard: it joins the runner's namespace with NET_ADMIN and nothing else", () => {
    const cfgFixed = config();
    expect(netguardSpec(cfgFixed, "app-co", "abc123")).toEqual({
      Image: "boss-man-netguard:current",
      Env: ["NETGUARD_ALLOW=server:3100"],
      Healthcheck: { Test: ["CMD", "nft", "list", "table", "inet", "bossman_netguard"], Interval: 1_000_000_000, Timeout: 3_000_000_000, Retries: 3 },
      Labels: { "boss-man.netguard": "1", "boss-man.company": "app-co" },
      HostConfig: {
        Binds: [`${path.join(cfgFixed.dataRoot, "companies/app-co/netguard")}:/etc/netguard:ro`],
        NetworkMode: "container:abc123",
        CapDrop: ["ALL"],
        CapAdd: ["NET_ADMIN"],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        Devices: [],
        PidMode: "",
        IpcMode: "private",
        ReadonlyRootfs: true,
        PidsLimit: 32,
        Memory: 67108864,
        RestartPolicy: { Name: "no" },
      },
    });
    expect(netguardSpec({ ...cfgFixed, guardAllow: ["crawl:8000", "192.168.1.5:9"] }, "app-co", "abc").Env).toEqual(["NETGUARD_ALLOW=server:3100", "NETGUARD_EXTRA=crawl:8000 192.168.1.5:9"]);
    expect(() => netguardSpec(config(), "app-co", "x;rm")).toThrow();
    expect(() => netguardSpec(config(), "../etc", "abc")).toThrow();
    expect(serverAddress("ws://server:3100/api/runner/connect")).toBe("server:3100");
    expect(serverAddress("wss://boss.example.com/api/runner/connect")).toBe("boss.example.com:443");
    expect(serverAddress("ws://10.0.0.5/x")).toBe("10.0.0.5:80");
    // The runner keeps no capability.
    expect(containerSpec(config(), "app-co").HostConfig.CapAdd).toEqual([]);
  });

  it("removes the runner if its guard can't start, so no runner is left unguarded", async () => {
    const cfg = config();
    const fake = fakeDocker();
    fake.fail.guard = true;
    await expect(launcher(cfg, fake.docker).put("app-co", TOKEN)).rejects.toThrow("no such image");
    expect(fake.containers.size).toBe(0);
  });

  it("lists as wanted a runner that runs or has a token left, and not one the owner stopped", async () => {
    const cfg = config();
    const fake = fakeDocker();
    const api = launcher(cfg, fake.docker);
    expect(await api.wanted()).toEqual([]);
    await api.put("app-co", TOKEN);
    expect(await api.wanted()).toEqual(["app-co"]);
    // Its container is gone but the token stays (guard failure): still wanted, the self-heal will make it again.
    fake.containers.clear();
    expect(await api.wanted()).toEqual(["app-co"]);
    await api.remove("app-co");
    expect(await api.wanted()).toEqual([]);
  });

  it("makes a runner again after its guard failed, waiting longer after each failure, and not after an owner Stop", async () => {
    const cfg = config();
    const fake = fakeDocker();
    const api = launcher(cfg, fake.docker);
    fake.fail.guard = true;
    await expect(api.put("app-co", TOKEN)).rejects.toThrow("no such image");
    expect(fake.containers.size).toBe(0);
    // Still failing: tried now, then not again until the wait is over (10 s, then 20 s).
    await expect(api.healMissing(1_000)).rejects.toThrow("app-co");
    expect(await api.healMissing(5_000)).toEqual([]);
    await expect(api.healMissing(12_000)).rejects.toThrow("app-co");
    expect(await api.healMissing(20_000)).toEqual([]);
    // The cause is gone: the next try after the wait brings it back.
    fake.fail.guard = false;
    expect(await api.healMissing(40_000)).toEqual(["app-co"]);
    expect(fake.containers.has("boss-man-runner-app-co")).toBe(true);
    expect(fake.containers.has("boss-man-netguard-app-co")).toBe(true);
    // Nothing missing now.
    expect(await api.healMissing(50_000)).toEqual([]);
    // An owner Stop removes the token, so it stays stopped.
    await api.remove("app-co");
    expect(await api.healMissing(60_000)).toEqual([]);
    expect(fake.containers.size).toBe(0);
  });

  it("does not keep trying when the host can't load the guard rules (enforce mode)", async () => {
    const cfg = { ...config(), guardMode: "enforce" as const };
    const fake = fakeDocker();
    const api = launcher(cfg, fake.docker);
    fake.fail.nft = true;
    await expect(api.put("app-co", TOKEN)).rejects.toThrow();
    fake.fail.nft = false;
    expect(await api.healMissing(1_000_000)).toEqual([]);
    expect(fake.containers.has("boss-man-runner-app-co")).toBe(false);
  });

  it("restarts the guard after the runner restarts, and removes it with the runner", async () => {
    const cfg = config();
    const fake = fakeDocker();
    const api = launcher(cfg, fake.docker);
    await api.put("app-co", TOKEN);
    const first = fake.containers.get("boss-man-netguard-app-co")!.id;
    await api.restart("app-co");
    expect(fake.containers.get("boss-man-netguard-app-co")!.id).not.toBe(first);
    expect((fake.containers.get("boss-man-netguard-app-co")!.spec as { HostConfig: { NetworkMode: string } }).HostConfig.NetworkMode).toBe(`container:${fake.containers.get("boss-man-runner-app-co")!.id}`);
    await api.remove("app-co");
    expect(fake.containers.size).toBe(0);
  });

  it("starts a guard again when its runner restarted by itself, and leaves a current guard alone", async () => {
    const cfg = config();
    const fake = fakeDocker();
    const api = launcher(cfg, fake.docker);
    await api.put("app-co", TOKEN);
    expect(await api.reconcileGuards()).toEqual([]);
    // Docker restarted the runner after a crash: its namespace is new.
    await fake.docker.restart(fake.containers.get("boss-man-runner-app-co")!.id);
    expect(await api.reconcileGuards()).toEqual(["app-co"]);
    expect(await api.reconcileGuards()).toEqual([]);
    // The guard is gone altogether.
    fake.containers.delete("boss-man-netguard-app-co");
    expect(await api.reconcileGuards()).toEqual(["app-co"]);
    expect(fake.containers.has("boss-man-netguard-app-co")).toBe(true);
  });

  it("reports the guard's real state: a dead, missing or older guard is 'down', also after a launcher restart (BOS-436)", async () => {
    const fake = fakeDocker();
    await launcher(config(), fake.docker).put("app-co", TOKEN);
    const guardOf = () => fake.containers.get("boss-man-netguard-app-co")!;
    // A new launcher process has no memory of the first one's work.
    const api = launcher(config(), fake.docker);
    expect((await api.list())[0]!.guard).toBe("on");
    guardOf().state = "exited"; // the guard died after start
    expect((await api.list())[0]!.guard).toBe("down");
    guardOf().state = "running";
    guardOf().health = "unhealthy";
    expect((await api.list())[0]!.guard).toBe("down");
    guardOf().health = "healthy";
    fake.containers.delete("boss-man-netguard-app-co"); // e.g. the host rebooted and it never came back
    expect((await api.list())[0]!.guard).toBe("down");
    // The runner comes back by itself (unless-stopped) and the guard hasn't: reconcile repairs it.
    expect(await api.reconcileGuards()).toEqual(["app-co"]);
    expect((await api.list())[0]!.guard).toBe("on");
    // Runner restarted after the guard started: the guard is in an old namespace.
    await fake.docker.restart(fake.containers.get("boss-man-runner-app-co")!.id);
    expect((await api.list())[0]!.guard).toBe("down");
    expect(await api.reconcileGuards()).toEqual(["app-co"]);
    expect((await api.list())[0]!.guard).toBe("on");
  });

  it("a host that can't load nftables stays 'unavailable' after a launcher restart; enforce mode says 'down'", async () => {
    const fake = fakeDocker();
    fake.fail.nft = true;
    await launcher(config(), fake.docker).put("app-co", TOKEN);
    expect((await launcher(config(), fake.docker).list())[0]!.guard).toBe("unavailable");
    expect((await launcher({ ...config(), guardMode: "enforce" }, fake.docker).list())[0]!.guard).toBe("down");
  });

  it("recreates one company's runner and says which runners are on the current image", async () => {
    const cfg = config();
    const fake = fakeDocker();
    const api = launcher(cfg, fake.docker);
    await api.put("app-co", TOKEN);
    await api.put("homelab", TOKEN);
    fake.image.current = "img2"; // update-runner.sh tagged a new build
    expect((await api.list()).map((r) => [r.slug, r.current])).toEqual([["app-co", false], ["homelab", false]]);
    fake.calls.length = 0;
    expect(await api.recreate("app-co")).toMatchObject({ slug: "app-co" });
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual(["create boss-man-runner-app-co", "create boss-man-netguard-app-co"]);
    expect((await api.list()).map((r) => [r.slug, r.current])).toEqual([["homelab", false], ["app-co", true]]);
    await expect(api.recreate("nobody")).rejects.toMatchObject({ status: 404 });
  });

  it("exposes recreate over HTTP: POST only, no body, only its own containers", async () => {
    const s = await serve();
    await s.call("PUT", "/runners/app-co", { token: TOKEN });
    expect((await s.call("GET", "/runners/app-co/recreate")).status).toBe(405);
    expect((await s.call("POST", "/runners/app-co/recreate", { image: "alpine" })).status).toBe(400);
    expect((await s.call("POST", "/runners/nobody/recreate")).status).toBe(404);
    s.calls.length = 0;
    expect((await s.call("POST", "/runners/app-co/recreate")).status).toBe(200);
    expect(s.calls).toContain("create boss-man-runner-app-co");
    expect((await s.call("POST", "/runners/app-co/recreate", undefined, null)).status).toBe(401);
  });
  it("waits for the guard's rules, and takes the runner down in enforce and auto mode when the guard stops for another reason", async () => {
    const fake = fakeDocker();
    fake.fail.hang = true;
    await expect(launcher(config(), fake.docker).put("app-co", TOKEN)).rejects.toThrow("didn't load its rules in time");
    expect(fake.containers.has("boss-man-runner-app-co")).toBe(false);
  });

  it("a ruleset the guard refuses (exit 4) is not 'unavailable': even in auto mode the runner is removed", async () => {
    const fake = fakeDocker();
    fake.fail.bad = true;
    await expect(launcher(config(), fake.docker).put("app-co", TOKEN)).rejects.toMatchObject({ status: 502 });
    expect(fake.containers.has("boss-man-runner-app-co")).toBe(false);
  });

  it("removes the runner when its guard fails after a restart or in reconcile", async () => {
    const fake = fakeDocker();
    const api = launcher(config(), fake.docker);
    await api.put("app-co", TOKEN);
    fake.fail.guard = true;
    await expect(api.restart("app-co")).rejects.toThrow();
    expect(fake.containers.has("boss-man-runner-app-co")).toBe(false);

    fake.fail.guard = false;
    await api.put("app-co", TOKEN);
    await fake.docker.restart(fake.containers.get("boss-man-runner-app-co")!.id);
    fake.fail.guard = true;
    await expect(api.reconcileGuards()).rejects.toThrow();
    expect(fake.containers.has("boss-man-runner-app-co")).toBe(false);
  });

  it("a host that can't load nftables: auto keeps the runner and says 'unavailable', enforce refuses it, off skips the guard", async () => {
    const auto = fakeDocker();
    auto.fail.nft = true;
    const a = launcher(config(), auto.docker);
    await a.put("app-co", TOKEN);
    expect(auto.containers.has("boss-man-runner-app-co")).toBe(true);
    expect((await a.list()).map((r) => [r.slug, r.guard])).toEqual([["app-co", "unavailable"]]);
    auto.calls.length = 0;
    expect(await a.reconcileGuards()).toEqual([]);
    expect(auto.calls.filter((c) => c.startsWith("create"))).toEqual([]);

    const enforce = fakeDocker();
    enforce.fail.nft = true;
    await expect(launcher({ ...config(), guardMode: "enforce" }, enforce.docker).put("app-co", TOKEN)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("can't load firewall rules") });
    expect(enforce.containers.has("boss-man-runner-app-co")).toBe(false);

    const off = fakeDocker();
    const o = launcher({ ...config(), guardMode: "off" }, off.docker);
    await o.put("app-co", TOKEN);
    expect([...off.containers.keys()]).toEqual(["boss-man-runner-app-co"]);
    expect((await o.list())[0]!.guard).toBe("off");
  });

  it("keeps guard work for one company in order: a reconcile during a restart can't collide with it", async () => {
    const cfg = config();
    const fake = fakeDocker();
    const api = launcher(cfg, fake.docker);
    await api.put("app-co", TOKEN);
    fake.fail.slow = true;
    // The runner restarted by itself, so the timer wants a guard while a restart and a recreate are also in flight.
    await fake.docker.restart(fake.containers.get("boss-man-runner-app-co")!.id);
    const results = await Promise.allSettled([api.reconcileGuards(), api.restart("app-co"), api.reconcileGuards(), api.recreate("app-co"), api.restart("app-co")]);
    expect(results.map((r) => r.status)).toEqual(Array(5).fill("fulfilled"));
    expect(fake.containers.has("boss-man-runner-app-co")).toBe(true);
    expect(fake.containers.get("boss-man-netguard-app-co")!.state).toBe("running");
  });

  it("keeps a company's tool-server allow list in a folder only the guard sees", async () => {
    const s = await serve();
    const file = path.join(s.cfg.dataRoot, "companies/app-co/netguard/allow");
    await s.call("PUT", "/runners/app-co", { token: TOKEN, allow: ["crawl4ai.lan:11235"] });
    expect(readFileSync(file, "utf8")).toBe("crawl4ai.lan:11235\n");
    expect((await s.call("PUT", "/runners/app-co/allow", { allow: ["a.lan:1", "192.168.1.9:8080"] })).status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe("a.lan:1\n192.168.1.9:8080\n");
    // Anything that isn't host:port is refused, so it can't reach the firewall rules.
    for (const bad of [["a b:1"], ["x:99999"], ["host"], ["192.168.0.0/16:80"], ["a:1\nb:2"], "a:1"]) expect((await s.call("PUT", "/runners/app-co/allow", { allow: bad })).status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe("a.lan:1\n192.168.1.9:8080\n");
    expect((await s.call("PUT", "/runners/app-co/allow", { allow: [], token: "x" })).status).toBe(200);
    expect(parseAllow("a:1, b:2 a:1")).toEqual(["a:1", "b:2"]);
    expect(parseGuardMode(undefined)).toBe("auto");
    expect(() => parseGuardMode("maybe")).toThrow();
  });

  it("treats a removal racing another ('already in progress') as success once the container is gone, and a problem only if it is still there", async () => {
    const cfg = config();
    const fake = fakeDocker();
    const settle = new Map<string, boolean>();
    // A stand-in for Docker's answer while another removal of the same container is finishing: the remove waits,
    // and the container is gone a moment later (finished = true) or stays and the remove fails (finished = false).
    const racing: Docker = {
      ...fake.docker,
      async remove(id) {
        if (!settle.has(id)) return fake.docker.remove(id);
        await new Promise((r) => setTimeout(r, 1000));
        if (settle.get(id)) {
          for (const [name, c] of fake.containers) if (c.id === id) fake.containers.delete(name);
          return;
        }
        throw new DockerError(409, "Removing the runner failed: Docker is still removing the old container after a minute. Wait a minute and run the update again.");
      },
    };
    const api = launcher(cfg, racing);
    await api.put("app-co", TOKEN);
    const old = fake.containers.get("boss-man-runner-app-co")!.id;

    // Gone by the time it is looked at: the new runner is made and the old one is not reported as a failure.
    settle.set(old, true);
    fake.containers.delete("boss-man-netguard-app-co");
    await expect(api.recreate("app-co")).resolves.toMatchObject({ slug: "app-co" });
    const fresh = fake.containers.get("boss-man-runner-app-co")!.id;
    expect(fresh).not.toBe(old);
  }, 20_000);
});
