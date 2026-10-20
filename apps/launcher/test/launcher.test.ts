import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerInfo, ContainerSummary, Docker } from "../src/docker.js";
import { launcher, launcherServer } from "../src/launcher.js";
import { containerSpec, parseMemory, type LauncherConfig } from "../src/spec.js";

const KEY = "k".repeat(43);
const TOKEN = `bmr_${"t".repeat(43)}`;

/** A stand-in Docker that keeps containers in memory and records each call. */
function fakeDocker() {
  const containers = new Map<string, { id: string; labels: Record<string, string>; spec: unknown; state: string }>();
  const calls: string[] = [];
  let n = 0;
  const docker: Docker = {
    async list(label) {
      calls.push(`list ${label}`);
      const [k, v] = label.split("=");
      return [...containers.entries()]
        .filter(([, c]) => c.labels[k!] === v)
        .map(([name, c]) => ({ Id: c.id, Names: [`/${name}`], Image: "boss-man-runner:current", State: c.state, Status: c.state, Labels: c.labels, Created: 0 }) as ContainerSummary);
    },
    async inspect(name) {
      calls.push(`inspect ${name}`);
      const c = containers.get(name);
      return c ? ({ Id: c.id, Name: `/${name}`, Config: { Labels: c.labels }, State: { Status: c.state } } as ContainerInfo) : null;
    },
    async create(name, spec) {
      calls.push(`create ${name}`);
      const id = `id${++n}`;
      containers.set(name, { id, labels: (spec as { Labels: Record<string, string> }).Labels, spec, state: "created" });
      return id;
    },
    async start(id) {
      calls.push(`start ${id}`);
      for (const c of containers.values()) if (c.id === id) c.state = "running";
    },
    async restart(id) {
      calls.push(`restart ${id}`);
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      for (const [name, c] of containers) if (c.id === id) containers.delete(name);
    },
  };
  return { docker, containers, calls };
}

const config = (): LauncherConfig => ({ dataRoot: mkdtempSync(path.join(tmpdir(), "bm-launch-")), network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4 * 1024 ** 3 });

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
    expect(containerSpec({ dataRoot: "/mnt/data", network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4294967296 }, "app-co")).toEqual({
      Image: "boss-man-runner:current",
      User: "1000:1000",
      Env: ["BOSSMAN_URL=ws://server:3100/api/runner/connect", "BOSSMAN_RUNNER_TOKEN_FILE=/run/secrets/runner_token"],
      Labels: { "boss-man.launcher": "1", "boss-man.company": "app-co" },
      HostConfig: {
        Binds: [
          "/mnt/data/companies/app-co/workspaces:/home/node/workspaces",
          "/mnt/data/companies/app-co/runner-data:/home/node/runner-data",
          "/mnt/data/companies/app-co/claude:/home/node/.claude",
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
        PidsLimit: 1024,
        Init: true,
        Memory: 4294967296,
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    const cfg = config();
    expect(() => containerSpec({ ...cfg, network: "host" }, "app-co")).toThrow();
    expect(() => containerSpec(cfg, "../etc")).toThrow();
    expect(parseMemory("4g")).toBe(4294967296);
    expect(parseMemory("512m")).toBe(536870912);
    expect(() => parseMemory("lots")).toThrow();
  });

  it("writes the token, creates and starts the runner, and recreates it on a second call", async () => {
    const s = await serve();
    const res = await s.call("PUT", "/runners/app-co", { token: TOKEN });
    expect(res.status).toBe(200);
    const file = path.join(s.cfg.dataRoot, "companies/app-co/runner.token");
    expect(readFileSync(file, "utf8")).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const sub of ["workspaces", "runner-data", "claude"]) expect(existsSync(path.join(s.cfg.dataRoot, "companies/app-co", sub))).toBe(true);
    expect(s.calls).toEqual(["inspect boss-man-runner-app-co", "create boss-man-runner-app-co", "start id1"]);

    await s.call("PUT", "/runners/app-co", { token: TOKEN });
    expect(s.calls.slice(3)).toEqual(["inspect boss-man-runner-app-co", "remove id1", "create boss-man-runner-app-co", "start id2"]);
    expect(await (await s.call("GET", "/runners")).json()).toEqual([{ slug: "app-co", state: "running", status: "running", image: "boss-man-runner:current" }]);

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
    s.containers.set("boss-man-runner-app-co", { id: "theirs", labels: {}, spec: {}, state: "running" });
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
    fake.containers.set("someone-else", { id: "x", labels: { "boss-man.launcher": "1", "boss-man.company": "app-co" }, spec: {}, state: "running" });
    expect(await api.recreateAll()).toEqual(["app-co", "homelab"]);
    expect(fake.containers.get("someone-else")!.id).toBe("x");
  });
});
