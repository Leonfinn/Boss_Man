// BOS-1227 (941c), design tests 13 and 14: the whole release moves (guard check, launcher, release-current, old images), first start
// without backup or soak, adopting what is already there, and the launcher's create allow-list. Against FakeDaemon, virtual clock.
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertSafeServerCreate } from "../src/docker.js";
import { converge, firstStart, reconcile } from "../src/firststart.js";
import { readReleaseCurrent } from "../src/helpers.js";
import { runMove } from "../src/move.js";
import { launcherSpec } from "../src/spec.js";
import { FakeDaemon, HELPER_CFG } from "./fake-daemon.js";
import { sha } from "./helpers.js";
import { closeAll, ins, setup } from "./swap-helpers.js";

afterEach(closeAll);

const writes = (d: FakeDaemon) => d.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${decodeURIComponent(c.path)}`);
const NEW = { launcher: sha("1"), netguard: sha("2"), runner: sha("3") };
const reg = "ghcr.io/leonfinn";
const old = (n: string) => `${reg}/boss-man-${n}@sha256:${"a".repeat(64)}`;

describe("test 13: after the server is done, the rest of the release moves", () => {
  test("guard check, then launcher (one at a time, the old one removed only after the new one is healthy), then old images", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    s.daemon.addLauncher("0.0.9");
    s.daemon.images.add(old("runner"));
    s.daemon.images.add(old("netguard"));
    await runMove(s.deps, ins());
    expect(s.state.get().stage).toBe("done");
    const w = writes(s.daemon);
    const at = (needle: string) => w.findIndex((x) => x.includes(needle));
    expect(at("test-updater-guardcheck")).toBeGreaterThan(at("/containers/server-blue/stop"));
    expect(at("create?name=launcher-next")).toBeGreaterThan(at("create?name=test-updater-guardcheck"));
    // The old launcher stops before the new one starts: never two launchers at once.
    expect(at("/containers/launcher/stop")).toBeGreaterThan(at("create?name=launcher-next"));
    const startNext = w.findIndex((x, i) => i > at("/containers/launcher/stop") && /\/start$/.test(x) && !x.includes("guardcheck"));
    expect(startNext).toBeGreaterThan(at("/containers/launcher/stop"));
    expect(at("DELETE /containers/launcher?")).toBeGreaterThan(startNext);
    expect(at("/containers/launcher-next/rename?name=launcher")).toBeGreaterThan(at("DELETE /containers/launcher?"));
    const l = s.daemon.find("launcher")!;
    expect(l.image).toBe(`${reg}/boss-man-launcher@${NEW.launcher}`);
    expect(l.running).toBe(true);
    expect(l.env).toContain(`BOSSMAN_RUNNER_IMAGE=${reg}/boss-man-runner@${NEW.runner}`);
    expect(l.env).toContain(`BOSSMAN_NETGUARD_IMAGE=${reg}/boss-man-netguard@${NEW.netguard}`);
    expect(s.daemon.find("launcher-next")).toBeUndefined();
    expect(s.state.get().helpers).toEqual({ release: "0.2.0", status: "moved", note: null });
  });

  test("release-current holds the new release's runner and guard digests, written whole", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    s.daemon.addLauncher("0.0.9");
    expect(readReleaseCurrent(s.cfg)).toBeNull();
    await runMove(s.deps, ins());
    const f = readReleaseCurrent(s.cfg)!;
    expect(f.version).toBe("0.2.0");
    expect(f.runner).toBe(`${reg}/boss-man-runner@${NEW.runner}`);
    expect(f.netguard).toBe(`${reg}/boss-man-netguard@${NEW.netguard}`);
    expect(existsSync(path.join(s.cfg.stateDir, "release-current.json.tmp"))).toBe(false);
  });

  test("old runner and guard images go only when Docker says nothing uses them; the one in use stays", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    s.daemon.addLauncher("0.0.9");
    // A company's runner container (made by the launcher, not carrying the install label) still runs the old runner image.
    s.daemon.containers.set("runner-acme", { ...s.daemon.addPlain("runner-acme", {}, old("runner")) });
    s.daemon.images.add(old("runner"));
    s.daemon.images.add(old("netguard"));
    await runMove(s.deps, ins());
    expect(s.daemon.imageDeletes).toEqual(expect.arrayContaining([old("runner"), old("netguard"), old("launcher")]));
    expect(s.daemon.images.has(old("runner"))).toBe(true);
    expect(s.daemon.images.has(old("netguard"))).toBe(false);
    // Runners and guards were never touched.
    expect(s.daemon.find("runner-acme")!.running).toBe(true);
    expect(w2(s.daemon)).not.toContain("runner-acme");
  });

  test("a launcher that stays busy for 10 minutes is not replaced; runners made now already use the new release", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    const l = s.daemon.addLauncher("0.0.9");
    s.deps.launcherBusy = async () => true;
    await runMove(s.deps, ins());
    expect(s.state.get().stage).toBe("done");
    expect(s.daemon.time).toBeGreaterThanOrEqual(600_000);
    expect(s.daemon.find("launcher")!.id).toBe(l.id);
    expect(s.daemon.find("launcher-next")).toBeUndefined();
    expect(s.state.get().helpers.status).toBe("pending");
    expect(s.state.get().report?.text).toMatch(/not replaced yet/);
    expect(readReleaseCurrent(s.cfg)?.version).toBe("0.2.0");
  });

  test("a run starting for a while, then clear: the launcher is replaced by the same move", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    s.daemon.addLauncher("0.0.9");
    let asked = 0;
    s.deps.launcherBusy = async () => ++asked <= 3;
    await runMove(s.deps, ins());
    expect(s.daemon.find("launcher")!.image).toContain(NEW.launcher);
    expect(s.state.get().helpers.status).toBe("moved");
  });

  test("the new launcher never becomes healthy: it is removed and the old one runs again", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    const l = s.daemon.addLauncher("0.0.9");
    s.daemon.newBootsHealthy = true;
    s.daemon.onStart = (n) => {
      if (n === "launcher-next") s.daemon.find(n)!.healthy = false;
    };
    await runMove(s.deps, ins());
    expect(s.daemon.find("launcher-next")).toBeUndefined();
    const back = s.daemon.find("launcher")!;
    expect(back.id).toBe(l.id);
    expect(back.running).toBe(true);
    expect(s.state.get().helpers.status).toBe("pending");
  });

  test("the new guard fails its check: the launcher is not touched", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    const l = s.daemon.addLauncher("0.0.9");
    s.daemon.guardExit = 1;
    await runMove(s.deps, ins());
    expect(s.daemon.find("launcher")!.id).toBe(l.id);
    expect(s.daemon.find("launcher-next")).toBeUndefined();
    expect(s.daemon.find("test-updater-guardcheck")).toBeUndefined();
    expect(s.state.get().helpers.status).toBe("pending");
    expect(s.state.get().helpers.note).toMatch(/network guard did not pass/);
  });

  test("a move that rolls back never writes release-current or touches the launcher", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    const l = s.daemon.addLauncher("0.0.9");
    s.daemon.newBootsHealthy = false;
    await runMove(s.deps, ins());
    expect(s.state.get().stage).not.toBe("done");
    expect(readReleaseCurrent(s.cfg)).toBeNull();
    expect(s.daemon.find("launcher")!.id).toBe(l.id);
  });

  test("an install without the launcher settings moves exactly as in 941b", async () => {
    const s = await setup();
    await runMove(s.deps, ins());
    expect(readReleaseCurrent(s.cfg)).toBeNull();
    expect(s.daemon.calls.some((c) => c.path.includes("/containers/launcher") || c.path.includes("guardcheck"))).toBe(false);
  });
});

const w2 = (d: FakeDaemon) => writes(d).join("\n");

describe("test 14: first start, adoption and convergence", () => {
  function fresh() {
    return setup({ live: false, cfg: HELPER_CFG });
  }
  const leader = (s: Awaited<ReturnType<typeof fresh>>) => {
    s.daemon.onStart = (n) => {
      if (n === "server-blue") s.daemon.find(n)!.role = "leader";
    };
  };

  test("an empty install gets the launcher and server-blue from the pinned release, with no backup and no soak", async () => {
    const s = await fresh();
    leader(s);
    const notes = await firstStart(s.deps);
    expect(notes.join(" ")).toMatch(/launcher was made/);
    expect(s.daemon.find("launcher")!.running).toBe(true);
    const blue = s.daemon.find("server-blue")!;
    expect(blue.running).toBe(true);
    expect(blue.networks["test_front"]).toEqual(["server-blue-front", "server-live"]);
    expect(blue.labels["com.bossman.release"]).toBe("0.0.9");
    expect(s.daemon.calls.some((c) => c.path.endsWith("/exec") || c.path.includes("-migrate"))).toBe(false);
    expect(s.daemon.time).toBeLessThan(60_000);
    expect(s.state.get().live).toBe("blue");
    expect(s.state.get().currentVersion).toBe("0.0.9");
  });

  test("a second start adopts what is there: nothing is created, nothing duplicated", async () => {
    const s = await fresh();
    leader(s);
    await firstStart(s.deps);
    s.daemon.calls.length = 0;
    expect(await firstStart(s.deps)).toEqual([]);
    expect(s.daemon.calls.filter((c) => c.method === "POST" && c.path.includes("create"))).toEqual([]);
  });

  test("a stopped launcher and a half-made launcher-next from an interrupted move: the old one runs again, the half-made one goes", async () => {
    const s = await fresh();
    leader(s);
    await firstStart(s.deps);
    s.daemon.find("launcher")!.running = false;
    s.daemon.addPlain("launcher-next", { "boss-man.install": "test", "com.bossman.helper": "launcher" }, old("launcher"));
    await firstStart(s.deps);
    expect(s.daemon.find("launcher")!.running).toBe(true);
    expect(s.daemon.find("launcher-next")).toBeUndefined();
  });

  test("the database never ready: nothing is made, the note says it is tried at the next start", async () => {
    const s = await fresh();
    s.daemon.find("test-db")!.running = false;
    const notes = await firstStart(s.deps);
    expect(notes.join(" ")).toMatch(/database was not ready/);
    expect(s.daemon.find("launcher")).toBeUndefined();
    expect(s.daemon.find("server-blue")).toBeUndefined();
  });

  test("reconcile reports a colour or launcher from another release, in the status, and changes nothing", async () => {
    const s = await setup({ cfg: HELPER_CFG, version: "0.2.0" });
    s.daemon.addLauncher("0.0.8");
    s.state.update({ currentVersion: "0.0.9" });
    const before = s.daemon.calls.length;
    const notes = await reconcile(s.deps);
    expect(notes.join(" ")).toMatch(/launcher is release 0.0.8/);
    expect(s.daemon.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    expect(s.state.get().reconcile?.notes).toEqual(notes);
  });

  test("a deferred launcher move is carried on by converge once the launcher is idle", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    s.daemon.addLauncher("0.0.9");
    s.deps.launcherBusy = async () => true;
    await runMove(s.deps, ins());
    expect(s.state.get().helpers.status).toBe("pending");
    s.deps.launcherBusy = async () => false;
    await converge(s.deps);
    expect(s.daemon.find("launcher")!.image).toContain(NEW.launcher);
    expect(s.state.get().helpers.status).toBe("moved");
  });

  test("compose started an older updater than the state records: it hands over to the recorded release", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    s.daemon.addLauncher("0.2.0");
    s.daemon.addPlain("updater", { "boss-man.install": "test" }, `${reg}/boss-man-updater@${sha("5")}`);
    s.state.update({ currentVersion: "0.2.0", helpers: { release: "0.2.0", status: "moved", note: null } });
    // This updater runs 0.0.9 (its configured release); the state says 0.2.0.
    s.daemon.onStart = (n) => void (n === "updater-next" && s.gate.expecting && void s.gate.expecting.run().catch(() => undefined));
    await converge(s.deps);
    expect(s.daemon.calls.some((c) => c.path === "/containers/create?name=updater-next")).toBe(true);
  });
});

describe("the launcher's create allow-list", () => {
  async function spec() {
    const s = await setup({ cfg: HELPER_CFG });
    const r = { version: "0.2.0", launcher: NEW.launcher, runner: NEW.runner, netguard: NEW.netguard };
    const allow = { labelKey: "boss-man.install", labelValue: "test", networks: [s.cfg.swap.launcherNetwork], volumes: s.cfg.swap.helpers!.launcherMounts.map((m) => m.source), kind: "launcher" as const, socketBind: `${s.cfg.swap.socketHostPath}:/var/run/docker.sock` };
    return { s, body: launcherSpec(s.cfg, r), allow };
  }
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

  test("the launcher's own spec passes", async () => {
    const { body, allow } = await spec();
    expect(() => assertSafeServerCreate(body, allow)).not.toThrow();
    expect(body.HostConfig.Privileged).toBe(false);
    expect(body.HostConfig.CapAdd).toEqual(["SETUID", "SETGID"]);
  });

  test.each([
    ["a second bind", (b: any) => b.HostConfig.Binds.push("/:/host")],
    ["another socket path", (b: any) => (b.HostConfig.Binds = ["/data:/var/run/docker.sock"])],
    ["no bind at all", (b: any) => (b.HostConfig.Binds = [])],
    ["privileged", (b: any) => (b.HostConfig.Privileged = true)],
    ["an extra capability", (b: any) => b.HostConfig.CapAdd.push("SYS_ADMIN")],
    ["a writable root", (b: any) => (b.HostConfig.ReadonlyRootfs = false)],
    ["a volume that is not the launcher's", (b: any) => b.HostConfig.Mounts.push({ Type: "volume", Source: "test_config", Target: "/x", ReadOnly: false })],
    ["a host-folder mount", (b: any) => b.HostConfig.Mounts.push({ Type: "bind", Source: "/", Target: "/x" })],
    ["a tag instead of a digest", (b: any) => (b.Image = "ghcr.io/leonfinn/boss-man-launcher:latest")],
    ["another network", (b: any) => (b.HostConfig.NetworkMode = "host")],
    ["no install label", (b: any) => (b.Labels = {})],
    ["another user", (b: any) => (b.User = "1000:1000")],
  ])("refused: %s", async (_n, mutate) => {
    const { body, allow } = await spec();
    const b = clone(body);
    mutate(b);
    expect(() => assertSafeServerCreate(b, allow)).toThrow(/refused to create/);
  });

  test("a server colour can still not hold the socket or the launcher's volumes", async () => {
    const { s, body, allow } = await spec();
    expect(() => assertSafeServerCreate(body, { ...allow, kind: "colour", volumes: [...s.cfg.swap.serverMounts.map((m) => m.source)] })).toThrow(/refused to create/);
  });
});
