// The Claude pack installer at the launcher (DR-050, BOS-972): it runs before the runner is made, the
// runner mounts the pack volume read-only, the installer mounts it read-write, and a failed install still
// lets the runner start (Claude absent, OpenCode and Codex keep working), never blocks it.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContainerInfo, ContainerSummary, Docker } from "../src/docker.js";
import { ensurePack, packContainerName, packInstallerSpec, packVolume } from "../src/claude-pack.js";
import { launcher } from "../src/launcher.js";
import { containerSpec, netguardSpec, type LauncherConfig } from "../src/spec.js";

const TOKEN = `bmr_${"t".repeat(43)}`;
const config = (): LauncherConfig => ({ dataRoot: mkdtempSync(path.join(tmpdir(), "bm-cpack-")), network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4 * 1024 ** 3, pidsLimit: 4096 });

type Spec = { Cmd?: string[]; Labels: Record<string, string>; HostConfig: { Binds?: string[]; Mounts?: Array<{ Type: string; Source: string; Target: string }>; NetworkMode: string } };

/** A stand-in Docker that records calls and reports the installer exiting with `exitCode`. */
function fakeDocker(exitCode = 0) {
  const calls: string[] = [];
  const specs = new Map<string, Spec>();
  const containers = new Map<string, { id: string; spec: Spec; labels: Record<string, string>; state: string; exitCode: number; health?: string }>();
  let n = 0;
  const byId = (id: string) => [...containers.values()].find((c) => c.id === id);
  const docker: Docker = {
    async list() {
      return [...containers.values()]
        .filter((c) => c.labels["boss-man.launcher"] === "1")
        .map((c) => ({ Id: c.id, Names: [`/x`], Image: "boss-man-runner:current", ImageID: "img", State: c.state, Status: c.state, Labels: c.labels, Created: 0 }) as ContainerSummary);
    },
    async inspect(name) {
      calls.push(`inspect ${name}`);
      const c = containers.get(name);
      if (!c) return null;
      return { Id: c.id, Name: `/${name}`, Config: { Labels: c.labels }, State: { Status: c.state, ...(c.health ? { Health: { Status: c.health } } : {}) } } as ContainerInfo;
    },
    async hostInfo() {
      return { dockerVersion: "27.0.1", osType: "linux" };
    },
    async createVolume(name, labels) {
      calls.push(`volume ${name} ${JSON.stringify(labels)}`);
    },
    async imageId() {
      return "img";
    },
    async create(name, spec) {
      calls.push(`create ${name}`);
      const id = `id${++n}`;
      const s = spec as Spec;
      specs.set(name, s);
      containers.set(name, { id, spec: s, labels: s.Labels, state: "created", exitCode });
      return id;
    },
    async start(id) {
      calls.push(`start ${id}`);
      const c = byId(id)!;
      c.state = "running";
      // A network guard is healthy as soon as it starts, so guardReady returns (this test is not about the guard).
      if (c.labels["boss-man.netguard"]) c.health = "healthy";
    },
    async wait(id) {
      calls.push(`wait ${id}`);
      const c = byId(id)!;
      c.state = "exited";
      return { stopped: true, exitCode: c.exitCode };
    },
    async restart() {},
    async pause() {},
    async unpause() {},
    async stop() {},
    async disconnect() {},
    async connect() {},
    async signal() {},
    async remove(id) {
      calls.push(`remove ${id}`);
      for (const [name, c] of containers) if (c.id === id) containers.delete(name);
    },
    events() {
      return Promise.resolve();
    },
  };
  return { docker, calls, specs, containers };
}

describe("the pack installer spec (DR-050)", () => {
  it("mounts the pack volume read-write and no company data, and runs the installer command", () => {
    const spec = packInstallerSpec(config(), "app-co");
    expect(spec.Cmd).toEqual(["node_modules/.bin/tsx", "src/claude-pack-main.ts"]);
    expect(spec.HostConfig.Mounts).toEqual([{ Type: "volume", Source: "boss-man-claude-pack", Target: "/opt/bossman-claude" }]);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect((spec.HostConfig as { LogConfig?: unknown }).LogConfig).toEqual({ Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } });
    expect(spec.Labels["boss-man.claude-pack"]).toBe("1");
    expect(packVolume()).toBe("boss-man-claude-pack");
    expect(packVolume("staging")).toBe("boss-man-staging-claude-pack");
    expect(packContainerName("app-co")).toBe("boss-man-claude-pack-app-co");
    expect(packContainerName("app-co", "staging")).toBe("boss-man-staging-claude-pack-app-co");
  });

  it("the runner mounts the volume read-only, the installer read-write", () => {
    expect(containerSpec(config(), "app-co").HostConfig.Binds).toContain("boss-man-claude-pack:/opt/bossman-claude:ro");
    expect(packInstallerSpec(config(), "app-co").HostConfig.Mounts![0]).toMatchObject({ Type: "volume", Target: "/opt/bossman-claude" });
    // The installer's volume is not read-only: it writes the pack into it.
    expect((packInstallerSpec(config(), "app-co").HostConfig.Mounts![0] as { ReadOnly?: boolean }).ReadOnly).toBeUndefined();
  });
});

describe("ensurePack", () => {
  it("runs the installer and reports a ready pack on exit 0", async () => {
    const fake = fakeDocker(0);
    expect(await ensurePack(fake.docker, config(), "app-co", () => {})).toBe(true);
    expect(fake.calls).toEqual(["inspect boss-man-claude-pack-app-co", "create boss-man-claude-pack-app-co", "start id1", "wait id1", "remove id1"]);
  });

  it("BOS-2803: with an install label, makes the pack volume with it and stamps it on the installer, runner and guard", async () => {
    const fake = fakeDocker(0);
    const cfg = { ...config(), installLabel: "com.bossman.install=demo" };
    expect(await ensurePack(fake.docker, cfg, "app-co", () => {})).toBe(true);
    expect(fake.calls[1]).toBe('volume boss-man-claude-pack {"com.bossman.install":"demo"}');
    const lab = (s: { Labels: object }) => (s.Labels as Record<string, string>)["com.bossman.install"];
    expect(lab(packInstallerSpec(cfg, "app-co"))).toBe("demo");
    expect(lab(containerSpec(cfg, "app-co"))).toBe("demo");
    expect(lab(netguardSpec(cfg, "app-co", "id1"))).toBe("demo");
    expect(lab(containerSpec(config(), "app-co"))).toBeUndefined();
  });

  it("BOS-2803: a volume that can't be labelled does not stop the install", async () => {
    const fake = fakeDocker(0);
    fake.docker.createVolume = async () => {
      throw new Error("nope");
    };
    const logs: string[] = [];
    expect(await ensurePack(fake.docker, { ...config(), installLabel: "com.bossman.install=demo" }, "app-co", (m) => logs.push(m))).toBe(true);
    expect(logs.join("\n")).toMatch(/couldn't label/);
  });

  it("BOS-2803: no label means no volume call", async () => {
    const fake = fakeDocker(0);
    await ensurePack(fake.docker, config(), "app-co", () => {});
    expect(fake.calls.some((c) => c.startsWith("volume"))).toBe(false);
  });

  it("reports not-ready on a non-zero exit, and never throws", async () => {
    const fake = fakeDocker(1);
    const logs: string[] = [];
    expect(await ensurePack(fake.docker, config(), "app-co", (m) => logs.push(m))).toBe(false);
    expect(logs.join("\n")).toMatch(/exited 1/);
  });

  it("removes a leftover installer from a crash before making a new one", async () => {
    const fake = fakeDocker(0);
    // A previous crash left a container with the installer's name.
    fake.containers.set("boss-man-claude-pack-app-co", { id: "old", spec: {} as Spec, labels: { "boss-man.claude-pack": "1" }, state: "exited", exitCode: 1 });
    expect(await ensurePack(fake.docker, config(), "app-co", () => {})).toBe(true);
    expect(fake.calls).toEqual(["inspect boss-man-claude-pack-app-co", "remove old", "create boss-man-claude-pack-app-co", "start id1", "wait id1", "remove id1"]);
  });

  it("shares ONE install between two companies on the same stack starting together (BOS-972)", async () => {
    // Two installers writing the shared pack volume would wipe each other's half-done npm ci; all companies on
    // a stack must share one install. Hold the first install open, start a second, then let it finish.
    const fake = fakeDocker(0);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.docker.wait = async (id: string, ms: number) => {
      fake.calls.push(`wait ${id}`);
      await gate;
      const c = [...fake.containers.values()].find((x) => x.id === id)!;
      c.state = "exited";
      return { stopped: true, exitCode: c.exitCode };
    };
    const cfg = config();
    const first = ensurePack(fake.docker, cfg, "app-co", () => {});
    const second = ensurePack(fake.docker, cfg, "other-co", () => {});
    // Let the first install reach its wait before releasing.
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual(["create boss-man-claude-pack-app-co"]);
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    // The second company never started its own installer: it shared the first's result.
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual(["create boss-man-claude-pack-app-co"]);
  });

  it("starts a fresh install once the previous one has finished (a stack isn't locked forever)", async () => {
    const fake = fakeDocker(0);
    const cfg = config();
    expect(await ensurePack(fake.docker, cfg, "app-co", () => {})).toBe(true);
    expect(await ensurePack(fake.docker, cfg, "other-co", () => {})).toBe(true);
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual(["create boss-man-claude-pack-app-co", "create boss-man-claude-pack-other-co"]);
  });
});

describe("the launcher runs the installer before a runner, and a failed pack never blocks it", () => {
  it("creates the installer first, then the runner, on a good install", async () => {
    const fake = fakeDocker(0);
    await launcher(config(), fake.docker).put("app-co", TOKEN);
    const created = fake.calls.filter((c) => c.startsWith("create"));
    expect(created[0]).toBe("create boss-man-claude-pack-app-co");
    expect(created).toContain("create boss-man-runner-app-co");
    // The installer's own container is gone afterwards; the runner stays.
    expect(fake.containers.has("boss-man-claude-pack-app-co")).toBe(false);
    expect(fake.containers.has("boss-man-runner-app-co")).toBe(true);
  });

  it("still starts the runner when the installer fails, and says Claude will be absent", async () => {
    const fake = fakeDocker(1);
    await launcher(config(), fake.docker).put("app-co", TOKEN);
    expect(fake.containers.has("boss-man-runner-app-co")).toBe(true);
  });
});
