// Design test 12 (part): the Docker client's allow-list. The list below is the whole of what the updater may ask Docker.
// Adding a call to src/docker.ts without adding it here fails the first test: a new reach is a decision, not an accident.
import { describe, expect, test } from "vitest";
import type { UpdaterError } from "../src/config.js";
import { ALLOWED_CALLS, assertSafeCreate, assertSafeServerCreate, demux, dockerClient, type ServerKind } from "../src/docker.js";
import { packInstallerSpec } from "../src/pack.js";
import { colourSpec, migrateSpec, updaterSpec, type SwapReady } from "../src/spec.js";
import { swapConfig } from "./fake-daemon.js";
import { fakeTransport, framed, sha, testConfig } from "./helpers.js";

const cfg = testConfig();
const opts = { installLabel: cfg.installLabel, volume: cfg.packVolume, network: cfg.network };
const ours = { Id: "abc", Config: { Labels: { "boss-man.install": "test" } }, State: { Running: false, ExitCode: 0 } };
const theirs = { Id: "zzz", Config: { Labels: { "com.docker.compose.project": "other" } }, State: { Running: true } };
const refuse = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as UpdaterError;
  }
  throw new Error("expected a refusal");
};

test("the allow-list is exactly these calls (941a)", () => {
  expect(ALLOWED_CALLS.map((a) => `${a.method} ${a.what}`)).toEqual([
    "GET the daemon's architecture",
    "GET inspect a container (labels, exit code)",
    "GET the end of a one-shot container's output",
    "POST create the one-shot pack installer (body built here, checked by assertSafeCreate)",
    "POST start the pack installer",
    "DELETE remove the pack installer (force also stops it at the timeout)",
    "POST pull an image by digest",
    "GET read back a pulled image's digest",
    "DELETE delete an image whose digest did not match",
    "GET list this install's containers by label (colours, standby)",
    "POST stop a container of this install (the old colour becomes the standby)",
    "POST demote (USR1) or promote (USR2) a server colour, as the host deployer does",
    "POST name the new updater after the hand-over",
    "POST set the old updater's restart policy to no at the hand-over",
    "POST attach a colour to a network with its aliases (flip: new colour first)",
    "POST detach a colour from a network (flip)",
    "POST create the fixed pg_dump command in the database container",
    "POST run that command",
    "GET read that command's exit code",
  ]);
});

describe("calls outside the list never reach the socket", () => {
  const { calls, transport } = fakeTransport(() => ({ json: ours }));
  const docker = dockerClient(transport, opts);
  test("every kind of reach the swap or an attacker would want is refused by the guard itself", async () => {
    // The guard function is not exposed: only these named methods exist, each of which goes through it.
    expect(Object.keys(docker).sort()).toEqual(["arch", "connect", "create", "createServer", "disconnect", "exec", "imageInfo", "inspectOurs", "listByLabel", "logs", "pull", "remove", "removeImage", "rename", "setRestartNever", "signal", "start", "stop", "wait"]);
    for (const [m, p] of [
      ["POST", "/containers/abc/kill"],
      ["POST", "/containers/abc/kill?signal=SIGKILL"],
      ["POST", "/containers/abc/kill?signal=SIGUSR1;x"],
      ["POST", "/build"],
      ["GET", "/containers/json"],
      ["GET", "/containers/json?all=1"],
      ["DELETE", "/networks/x"],
      ["POST", "/networks/create"],
      ["DELETE", "/volumes/x"],
      ["POST", "/volumes/create"],
      ["GET", "/containers/abc/archive"],
      ["PUT", "/containers/abc/archive"],
      ["POST", "/containers/abc/rename"],
      ["POST", "/containers/abc/exec/start"],
      ["POST", "/exec/abc/start"],
      ["POST", "/images/load"],
      ["POST", "/commit"],
      ["POST", "/containers/abc/restart"],
      ["POST", "/containers/abc/pause"],
    ] as const) {
      const ok = ALLOWED_CALLS.some((a) => a.method === m && a.pattern.test(p));
      expect(ok, `${m} ${p}`).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});

describe("the label check", () => {
  test("a container without this install's label is refused for start, remove, logs and wait; nothing is sent after the inspect", async () => {
    const { calls, transport } = fakeTransport(() => ({ json: theirs }));
    const docker = dockerClient(transport, opts);
    for (const fn of [() => docker.start("zzz"), () => docker.remove("zzz"), () => docker.logs("zzz"), () => docker.wait("zzz", 1, 1)]) {
      expect((await refuse(fn())).code).toBe("docker_refused");
    }
    expect(calls.every((c) => c.method === "GET" && c.path === "/containers/zzz/json")).toBe(true);
  });

  test("a container of this install is started and removed", async () => {
    const { calls, transport } = fakeTransport((c) => (c.method === "GET" ? { json: ours } : { status: 204 }));
    const docker = dockerClient(transport, opts);
    await docker.start("abc");
    await docker.remove("abc");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /containers/abc/json", "POST /containers/abc/start", "GET /containers/abc/json", "DELETE /containers/abc?force=1&v=1"]);
  });

  test("removing what is not there is fine", async () => {
    const { transport } = fakeTransport(() => undefined);
    await dockerClient(transport, opts).remove("gone");
  });
});

describe("what a create may ask for", () => {
  const good = () => packInstallerSpec(cfg, `ghcr.io/leonfinn/boss-man-runner@${sha("a")}`);
  const key = { volume: cfg.packVolume, network: cfg.network, labelKey: "boss-man.install", labelValue: "test" };

  test("the pack installer's own spec passes", () => assertSafeCreate(good(), key));

  test.each<[string, (s: ReturnType<typeof good>) => unknown]>([
    ["a tag instead of a digest", (s) => ({ ...s, Image: "ghcr.io/x/y:latest" })],
    ["no install label", (s) => ({ ...s, Labels: {} })],
    ["running as root", (s) => ({ ...s, User: "0:0" })],
    ["privileged", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Privileged: true } })],
    ["a host folder", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Binds: ["/:/host"] } })],
    ["the Docker socket mounted", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Target: "/s" }] } })],
    ["another volume", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Mounts: [{ Type: "volume", Source: "company-data", Target: "/d" }] } })],
    ["two mounts", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Mounts: [...s.HostConfig.Mounts, ...s.HostConfig.Mounts] } })],
    ["host network", (s) => ({ ...s, HostConfig: { ...s.HostConfig, NetworkMode: "host" } })],
    ["host pid space", (s) => ({ ...s, HostConfig: { ...s.HostConfig, PidMode: "host" } })],
    ["an added capability", (s) => ({ ...s, HostConfig: { ...s.HostConfig, CapAdd: ["SYS_ADMIN"] } })],
    ["capabilities kept", (s) => ({ ...s, HostConfig: { ...s.HostConfig, CapDrop: [] } })],
    ["a device", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Devices: [{ PathOnHost: "/dev/sda" }] } })],
  ])("refuses %s", (_n, mutate) => {
    expect(() => assertSafeCreate(mutate(good()), key)).toThrowError(/refused to create/);
  });

  test("create sends nothing when the spec is unsafe", async () => {
    const { calls, transport } = fakeTransport(() => ({ json: { Id: "n" }, status: 201 }));
    const docker = dockerClient(transport, opts);
    await refuse(docker.create("x", { ...good(), User: "0:0" }));
    expect(calls).toEqual([]);
    await expect(docker.create("x", good())).resolves.toBe("n");
    expect(calls).toHaveLength(1);
  });

  test("the installer container carries the label, no capability and no secret", () => {
    const s = good();
    expect(s.Labels["boss-man.install"]).toBe("test");
    expect(JSON.stringify(s)).not.toMatch(/key|token|password|secret/i);
  });
});

test("log framing is removed", () => {
  expect(demux(Buffer.concat([framed("one\n"), framed("two\n")]))).toBe("one\ntwo\n");
  expect(demux(Buffer.from("plain text"))).toBe("plain text");
});

test("a pull whose stream reports an error fails even though HTTP said 200", async () => {
  const { transport } = fakeTransport(() => ({ body: Buffer.from('{"status":"Pulling"}\n{"error":"toomanyrequests: rate limit"}\n') }));
  await expect(dockerClient(transport, opts).pull("ghcr.io/x/y@" + sha("a"))).rejects.toThrow(/rate limit/);
});

describe("what a server colour, the migrate one-shot or the next updater may ask for (941b)", () => {
  const sw = swapConfig() as SwapReady;
  const image = `ghcr.io/leonfinn/boss-man-server@${sha("7")}`;
  const allow = (kind: ServerKind) => ({ labelKey: "boss-man.install", labelValue: "test", networks: [sw.network, sw.swap.frontNetwork, sw.swap.launcherNetwork, sw.swap.selfNetwork], volumes: [...sw.swap.serverMounts, ...sw.swap.selfMounts].map((m) => m.source), kind, socketBind: "/var/run/docker.sock:/var/run/docker.sock" });
  const colour = () => colourSpec(sw, { colour: "green", image, version: "0.2.0", digest: sha("7"), role: "standby" });

  test("the three specs pass their own kind's check", () => {
    assertSafeServerCreate(colour(), allow("colour"));
    assertSafeServerCreate(migrateSpec(sw, image, "0.2.0"), allow("migrate"));
    assertSafeServerCreate(updaterSpec(sw, image, "0.2.0", sha("7")), allow("updater"));
  });

  test.each<[string, (s: ReturnType<typeof colour>) => unknown]>([
    ["a tag instead of a digest", (s) => ({ ...s, Image: "ghcr.io/x/y:latest" })],
    ["no install label", (s) => ({ ...s, Labels: {} })],
    ["a user set", (s) => ({ ...s, User: "0:0" })],
    ["privileged", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Privileged: true } })],
    ["a host folder", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Binds: ["/:/host"] } })],
    ["the Docker socket in a colour", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Binds: ["/var/run/docker.sock:/var/run/docker.sock"] } })],
    ["a volume the install does not list", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Mounts: [{ Type: "volume", Source: "company-data", Target: "/d" }] } })],
    ["a bind mount through Mounts", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Mounts: [{ Type: "bind", Source: "/etc", Target: "/e" }] } })],
    ["host network", (s) => ({ ...s, HostConfig: { ...s.HostConfig, NetworkMode: "host" } })],
    ["host pid space", (s) => ({ ...s, HostConfig: { ...s.HostConfig, PidMode: "host" } })],
    ["host ipc", (s) => ({ ...s, HostConfig: { ...s.HostConfig, IpcMode: "host" } })],
    ["an added capability", (s) => ({ ...s, HostConfig: { ...s.HostConfig, CapAdd: ["SYS_ADMIN"] } })],
    ["capabilities kept", (s) => ({ ...s, HostConfig: { ...s.HostConfig, CapDrop: [] } })],
    ["a device", (s) => ({ ...s, HostConfig: { ...s.HostConfig, Devices: [{ PathOnHost: "/dev/sda" }] } })],
    ["no restart policy", (s) => ({ ...s, HostConfig: { ...s.HostConfig, RestartPolicy: undefined } })],
  ])("a colour refuses %s", (_n, mutate) => {
    expect(() => assertSafeServerCreate(mutate(colour()), allow("colour"))).toThrowError(/refused to create/);
  });

  test("the next updater may bind only the socket, and nothing else, and must have it", () => {
    const u = updaterSpec(sw, image, "0.2.0", sha("7"));
    expect(() => assertSafeServerCreate({ ...u, HostConfig: { ...u.HostConfig, Binds: ["/:/host"] } }, allow("updater"))).toThrowError(/refused to create/);
    expect(() => assertSafeServerCreate({ ...u, HostConfig: { ...u.HostConfig, Binds: [...u.HostConfig.Binds, "/etc:/e"] } }, allow("updater"))).toThrowError(/refused to create/);
    expect(() => assertSafeServerCreate({ ...u, HostConfig: { ...u.HostConfig, CapAdd: ["SETUID", "SETGID", "NET_ADMIN"] } }, allow("updater"))).toThrowError(/refused to create/);
    expect(() => assertSafeServerCreate({ ...u, User: "1000:1000" }, allow("updater"))).toThrowError(/refused to create/);
  });

  test("a network that is not the install's is refused before anything is sent", async () => {
    const { calls, transport } = fakeTransport(() => ({ json: ours }));
    const docker = dockerClient(transport, { ...opts, networks: [cfg.network, "test_front"] });
    expect((await refuse(docker.connect("bridge", "abc", []))).code).toBe("docker_refused");
    expect((await refuse(docker.disconnect("host", "abc"))).code).toBe("docker_refused");
    expect(calls).toEqual([]);
  });

  test("the colour's label check applies to stop, signal, rename and exec too", async () => {
    const { calls, transport } = fakeTransport(() => ({ json: theirs }));
    const docker = dockerClient(transport, opts);
    for (const fn of [() => docker.stop("zzz", 5), () => docker.signal("zzz", "SIGUSR1"), () => docker.rename("zzz", "n"), () => docker.exec("zzz", ["true"], "0"), () => docker.setRestartNever("zzz")]) {
      expect((await refuse(fn())).code).toBe("docker_refused");
    }
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});
