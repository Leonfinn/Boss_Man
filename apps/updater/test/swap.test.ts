// Design tests 5 to 9 (941b): the swap's order, the colour spec, a failure at each step leaving the live colour untouched, the soak's
// switch-back, and a restart at each saved state. All against FakeDaemon, a stateful fake of the Docker API, with a virtual clock.
import { afterEach, describe, expect, test } from "vitest";
import { ALLOWED_CALLS } from "../src/docker.js";
import { currentVersion, recover, runMove } from "../src/move.js";
import { colourNetworks, colourSpec, migrateSpec, type SwapReady } from "../src/spec.js";
import { stateStore, type State } from "../src/state.js";
import { FakeDaemon, LABEL, NEW_COMMIT, OLD_COMMIT, swapConfig } from "./fake-daemon.js";
import { closeAll, D_SERVER, ins, rel, setup } from "./swap-helpers.js";

afterEach(closeAll);

/** The calls that change something, without the reads, so an order can be compared. */
const writes = (d: FakeDaemon) => d.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${decodeURIComponent(c.path)}`);

describe("test 5: the swap's order, and nothing outside the allow-list", () => {
  test("a move from blue to green makes exactly these changes, in this order", async () => {
    const s = await setup();
    await runMove(s.deps, ins());
    expect(s.state.get().stage).toBe("done");
    expect(s.state.get().error).toBeNull();
    const w = writes(s.daemon);
    const from = w.findIndex((x) => x.endsWith("/exec"));
    expect(w.slice(from).map((x) => x.replace(/\/exec\/[0-9a-f]{64}/, "/exec/ID").replace(/\/containers\/id\d+0+/, "/containers/MIGRATE"))).toEqual([
      "POST /containers/test-db/exec",
      "POST /exec/ID/start",
      "POST /containers/create?name=test-updater-migrate",
      "POST /containers/MIGRATE/start",
      "DELETE /containers/MIGRATE?force=1&v=1",
      "POST /containers/create?name=server-green",
      "POST /networks/test_launcher/connect",
      "POST /networks/test_front/connect",
      "POST /containers/server-green/start",
      "POST /containers/server-blue/kill?signal=SIGUSR1",
      "POST /containers/server-green/kill?signal=SIGUSR2",
      "POST /networks/test_front/disconnect",
      "POST /networks/test_front/connect",
      "POST /networks/test_front/disconnect",
      "POST /networks/test_front/connect",
      "POST /containers/server-blue/stop?t=60",
    ]);
    // Before the backup: only the pulls and the pack installer, nothing on a colour.
    expect(w.slice(0, from).some((x) => x.includes("server-") || x.includes("/networks/") || x.includes("kill"))).toBe(false);
    expect(w.slice(0, from).filter((x) => x.startsWith("POST /images/create"))).toHaveLength(5);
  });

  test("every call that reached Docker is on the allow-list", async () => {
    const s = await setup();
    await runMove(s.deps, ins());
    for (const c of s.daemon.calls) expect(ALLOWED_CALLS.some((a) => a.method === c.method && a.pattern.test(c.path)), `${c.method} ${c.path}`).toBe(true);
  });

  test("the result: green leads and holds the alias, blue is stopped as the standby, the install runs 0.2.0", async () => {
    const s = await setup();
    await runMove(s.deps, ins());
    const d = s.daemon;
    expect(d.holder("server-live")?.name).toBe("server-green");
    expect(d.find("server-green")).toMatchObject({ running: true, role: "leader" });
    expect(d.find("server-blue")).toMatchObject({ running: false });
    expect(d.find("server-blue")!.networks["test_front"]).toEqual(["server-blue-front"]);
    expect(await currentVersion(s.deps)).toBe("0.2.0");
    expect(s.state.get().report?.text).toMatch(/Updated to 0\.2\.0/);
    expect(s.state.get().backup).toMatch(/^bossman-\d{8}-\d{6}\.sql\.gz$/);
  });

  test("the backup command keeps three files and is fixed text, run as root in the database container", async () => {
    const s = await setup();
    await runMove(s.deps, ins());
    const c = s.daemon.calls.find((x) => x.path === "/containers/test-db/exec")!.body as { User: string; Cmd: string[] };
    expect(c.User).toBe("0");
    expect(c.Cmd.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(c.Cmd[2]).toMatch(/set -eo pipefail/);
    expect(c.Cmd[2]).toMatch(/tail -n \+4/);
    expect(c.Cmd[2]).toMatch(/gzip -t/);
  });

  test("the next move removes the colour before the standby, with its image, so there are never three", async () => {
    const s = await setup();
    await runMove(s.deps, ins());
    expect(s.daemon.names().sort()).toEqual(["server-blue", "server-green"]);
    // A second release, to blue again: the stopped standby (blue) is removed and made anew.
    const second = await setup({ version: "0.3.0" });
    second.daemon.containers = s.daemon.containers;
    await runMove(second.deps, { version: "0.3.0", serverDigest: D_SERVER });
    expect(second.state.get().stage).toBe("done");
    expect(second.daemon.names().sort()).toEqual(["server-blue", "server-green"]);
    expect(second.daemon.find("server-blue")!.labels["com.bossman.release"]).toBe("0.3.0");
    expect(second.daemon.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/images/"))).toBe(true);
  });
});

describe("test 6: the colour spec", () => {
  const cfg = swapConfig() as SwapReady;
  const image = `ghcr.io/leonfinn/boss-man-server@${D_SERVER}`;
  const both = () => ({
    blue: colourSpec(cfg, { colour: "blue", image, version: "0.2.0", digest: D_SERVER, role: "standby" }),
    green: colourSpec(cfg, { colour: "green", image, version: "0.2.0", digest: D_SERVER, role: "standby" }),
    networks: { blue: colourNetworks(cfg, "blue", false), green: colourNetworks(cfg, "green", false), liveGreen: colourNetworks(cfg, "green", true) },
    migrate: migrateSpec(cfg, image, "0.2.0"),
  });

  test("both colours match the golden file", async () => {
    await expect(JSON.stringify(both(), null, 2) + "\n").toMatchFileSnapshot("./fixtures/colour-spec.golden.json");
  });

  test("the whole override list, and nothing copied from an inspect result or from compose", () => {
    const { blue, green } = both();
    for (const [name, spec] of [["blue", blue], ["green", green]] as const) {
      expect(Object.keys(spec).sort()).toEqual(["Env", "HostConfig", "Hostname", "Image", "Labels", "StopTimeout"]);
      // Left to the image: nothing here may set them.
      for (const k of ["Cmd", "Entrypoint", "WorkingDir", "User", "Healthcheck", "ExposedPorts", "NetworkingConfig"]) expect(spec).not.toHaveProperty(k);
      expect(spec.Hostname).toBe(`server-${name}`);
      expect(spec.Env).toContain(`BOSSMAN_COLOUR=${name}`);
      expect(spec.Env).toContain("BOSSMAN_ROLE=standby");
      expect(Object.keys(spec.Labels).sort()).toEqual(["boss-man.install", "com.bossman.colour", "com.bossman.digest", "com.bossman.managed", "com.bossman.release"]);
      expect(Object.keys(spec.Labels).some((k) => k.startsWith("com.docker.compose"))).toBe(false);
    }
    // The only values that differ between the colours are the override list's.
    const strip = (s: typeof blue) => JSON.stringify({ ...s, Hostname: "", Env: s.Env.filter((e) => !e.startsWith("BOSSMAN_COLOUR=")), Labels: { ...s.Labels, "com.bossman.colour": "" } });
    expect(strip(blue)).toBe(strip(green as unknown as typeof blue));
  });

  test("the new colour is created with only its own alias; `server-live` is added at the flip", () => {
    const n = both().networks;
    expect(n.green.find((x) => x.network === "test_front")!.aliases).toEqual(["server-green-front"]);
    expect(n.liveGreen.find((x) => x.network === "test_front")!.aliases).toEqual(["server-green-front", "server-live"]);
    expect(both().green.HostConfig).not.toHaveProperty("Binds");
  });
});

describe("test 7: a failure at each step leaves the live colour untouched, and the owner is told", () => {
  const liveUntouched = (s: Awaited<ReturnType<typeof setup>>) => {
    const blue = s.daemon.find("server-blue")!;
    expect(blue).toMatchObject({ running: true, role: "leader" });
    expect(s.daemon.holder("server-live")?.name).toBe("server-blue");
    expect(s.daemon.calls.some((c) => c.path.startsWith("/containers/server-blue/stop"))).toBe(false);
    expect(s.daemon.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/containers/server-blue"))).toBe(false);
  };
  const told = (s: Awaited<ReturnType<typeof setup>>, code: string, re: RegExp) => {
    expect(s.state.get().stage).toBe("failed");
    expect(s.state.get().error?.code).toBe(code);
    expect(s.state.get().report).toMatchObject({ level: "problem", acknowledged: false });
    expect(s.state.get().report?.text).toMatch(re);
  };

  test("the backup fails: nothing after it runs", async () => {
    const s = await setup();
    s.daemon.execExit = 1;
    await runMove(s.deps, ins());
    told(s, "backup_failed", /backup failed/);
    liveUntouched(s);
    expect(s.daemon.names()).toEqual(["server-blue"]);
    expect(s.daemon.calls.some((c) => c.path.includes("migrate"))).toBe(false);
  });

  test("the migration fails: no colour is created", async () => {
    const s = await setup();
    s.daemon.migrateExit = 1;
    await runMove(s.deps, ins());
    told(s, "migrate_failed", /database update failed/);
    liveUntouched(s);
    expect(s.daemon.names()).toEqual(["server-blue"]);
  });

  test("the new colour never becomes healthy: it is removed, nothing is flipped or signalled", async () => {
    const s = await setup();
    s.daemon.newBootsHealthy = false;
    await runMove(s.deps, ins());
    told(s, "colour_unhealthy", /did not become healthy/);
    liveUntouched(s);
    expect(s.daemon.names()).toEqual(["server-blue"]);
    expect(s.daemon.signals).toEqual([]);
  });

  test("the live colour will not step down: it leads again and the new colour is removed", async () => {
    const s = await setup();
    s.daemon.failCall = (c) => (c.path === "/containers/server-blue/kill?signal=SIGUSR1" ? { status: 500, body: Buffer.from('{"message":"boom"}') } : undefined);
    await runMove(s.deps, ins());
    told(s, "handover_failed", /current version leads again/);
    liveUntouched(s);
    expect(s.daemon.names()).toEqual(["server-blue"]);
  });

  test("the new colour never takes over: the old one is promoted again", async () => {
    const s = await setup();
    s.daemon.failCall = (c) => (c.path === "/containers/server-green/kill?signal=SIGUSR2" ? { status: 500, body: Buffer.from('{"message":"boom"}') } : undefined);
    await runMove(s.deps, ins());
    told(s, "handover_failed", /take over/);
    liveUntouched(s);
    expect(s.daemon.signals).toContain("server-blue SIGUSR2");
  });

  test("the pack is not ready: nothing on a colour or the network is touched (test 4's order)", async () => {
    const s = await setup({ release: rel({ packHash: "f".repeat(24) }) });
    await runMove(s.deps, ins());
    expect(s.state.get().stage).toBe("failed");
    liveUntouched(s);
    expect(s.daemon.calls.some((c) => c.path.includes("/networks/") || c.path.includes("/exec") || c.path.includes("kill"))).toBe(false);
  });

  test("the running version is unhealthy before the move: it is not started", async () => {
    const s = await setup();
    s.daemon.find("server-blue")!.healthy = false;
    await runMove(s.deps, ins());
    told(s, "live_unhealthy", /not healthy/);
    expect(s.daemon.calls.some((c) => c.path.includes("exec"))).toBe(false);
  });

  test("a release that needs a newer layout is refused in plain words and nothing is changed", async () => {
    const s = await setup({ release: rel({ installLayout: 2 }), cfg: {} });
    await runMove(s.deps, ins());
    told(s, "layout_newer", /install-file change/);
    liveUntouched(s);
    expect(s.daemon.calls.some((c) => c.path.includes("exec"))).toBe(false);
  });
});

describe("test 8: a failing soak switches back by itself", () => {
  test("the live colour fails for 60 s: the alias goes back and the old colour leads", async () => {
    const s = await setup();
    // After the flip the new colour starts failing at 5 minutes into the soak.
    let flippedAt = -1;
    const probe = s.daemon.probe;
    s.deps.probe = async (host) => {
      if (flippedAt < 0 && s.daemon.holder("server-live")?.name === "server-green" && host === "server-live") flippedAt = s.daemon.time;
      if (flippedAt >= 0 && s.daemon.time - flippedAt > 300_000 && host === "server-live" && s.daemon.holder("server-live")?.name === "server-green") return null;
      return probe(host);
    };
    await runMove(s.deps, ins());
    expect(s.state.get().stage).toBe("rolled-back");
    expect(s.state.get().report).toMatchObject({ level: "problem" });
    expect(s.state.get().report?.text).toMatch(/went back to the previous version by itself/);
    expect(s.daemon.holder("server-live")?.name).toBe("server-blue");
    expect(s.daemon.find("server-blue")).toMatchObject({ running: true, role: "leader" });
    expect(s.daemon.find("server-green")).toMatchObject({ running: false });
    // It waited out 60 s, not the first failed check.
    expect(s.daemon.time - flippedAt).toBeGreaterThanOrEqual(360_000);
  });

  test("one failed check that recovers inside 60 s does not switch back", async () => {
    const s = await setup();
    let n = 0;
    const probe = s.daemon.probe;
    s.deps.probe = async (host) => (host === "server-live" && s.daemon.holder("server-live")?.name === "server-green" && ++n === 40 ? null : probe(host));
    await runMove(s.deps, ins());
    expect(s.state.get().stage).toBe("done");
    expect(s.daemon.holder("server-live")?.name).toBe("server-green");
  });

  test("the soak lasts 900 s before the old colour is stopped", async () => {
    const s = await setup();
    await runMove(s.deps, ins());
    expect(s.daemon.time).toBeGreaterThanOrEqual(900_000);
    const stopAt = s.daemon.calls.findIndex((c) => c.path.startsWith("/containers/server-blue/stop"));
    expect(stopAt).toBeGreaterThan(0);
  });
});

describe("test 9: a restart in the middle of a move resumes or cleans up", () => {
  const put = (s: Awaited<ReturnType<typeof setup>>, change: Partial<State>) => {
    s.state.update({ version: "0.2.0", serverDigest: D_SERVER, live: "blue", idle: "green", commit: NEW_COMMIT, ...change });
  };
  /** A new colour that exists, running, as it would after "starting-colour". */
  const withGreen = (s: Awaited<ReturnType<typeof setup>>, role: "standby" | "leader" = "standby", front = ["server-green-front"]) => {
    const g = s.daemon.addLive("green", "0.2.0", { live: false, digestChar: "7" });
    g.commit = NEW_COMMIT;
    g.role = role;
    g.networks["test_front"] = front;
    return g;
  };

  test.each(["backing-up", "migrating", "starting-colour", "handing-over"] as const)("%s: the new colour and the migrate one-shot are removed, the live colour leads, the move is failed", async (stage) => {
    const s = await setup();
    withGreen(s);
    s.daemon.addPlain("test-updater-migrate");
    s.daemon.find("server-blue")!.role = "standby"; // died after the demote
    put(s, { stage });
    await recover(s.deps);
    expect(s.daemon.names().sort()).toEqual(["server-blue"]);
    expect(s.daemon.find("server-blue")).toMatchObject({ running: true });
    expect(s.daemon.signals).toContain("server-blue SIGUSR2");
    expect(s.state.get()).toMatchObject({ stage: "failed", error: { code: "interrupted" } });
    expect(s.state.get().report?.text).toMatch(/keeps serving/);
  });

  test("flipping, new colour answers as the leader: the flip is finished and the soak carried on to done", async () => {
    const s = await setup();
    const g = withGreen(s, "leader", ["server-green-front", "server-live"]);
    s.daemon.find("server-blue")!.role = "standby";
    put(s, { stage: "flipping" });
    const resumed = await recover(s.deps);
    await resumed;
    expect(s.state.get().stage).toBe("done");
    expect(s.daemon.holder("server-live")?.name).toBe("server-green");
    expect(g.running).toBe(true);
    expect(s.daemon.find("server-blue")).toMatchObject({ running: false });
  });

  test("flipping, new colour not answering: switched back, rolled-back", async () => {
    const s = await setup();
    const g = withGreen(s, "standby", ["server-green-front"]);
    g.healthy = false;
    s.daemon.find("server-blue")!.role = "standby";
    put(s, { stage: "flipping" });
    await recover(s.deps);
    expect(s.state.get().stage).toBe("rolled-back");
    expect(s.daemon.holder("server-live")?.name).toBe("server-blue");
    expect(s.daemon.find("server-blue")).toMatchObject({ running: true, role: "leader" });
  });

  test("soaking: resumed from the saved deadline, the old colour is stopped at its end", async () => {
    const s = await setup();
    withGreen(s, "leader", ["server-green-front", "server-live"]);
    s.daemon.find("server-blue")!.networks["test_front"] = ["server-blue-front"];
    s.daemon.find("server-blue")!.role = "standby";
    s.daemon.time = 1_000_000;
    put(s, { stage: "soaking", soakUntil: new Date(1_000_000 + 120_000).toISOString() });
    await (await recover(s.deps));
    expect(s.state.get().stage).toBe("done");
    expect(s.daemon.time).toBeLessThan(1_000_000 + 400_000);
    expect(s.daemon.find("server-blue")).toMatchObject({ running: false });
  });

  test("stopping-old: the old colour is stopped and the move is done", async () => {
    const s = await setup();
    withGreen(s, "leader", ["server-green-front", "server-live"]);
    s.daemon.find("server-blue")!.networks["test_front"] = ["server-blue-front"];
    put(s, { stage: "stopping-old" });
    await recover(s.deps);
    expect(s.state.get().stage).toBe("done");
    expect(s.daemon.find("server-blue")).toMatchObject({ running: false });
  });

  test("the stopped standby is never started by a restart, and the live colour is never removed", async () => {
    const s = await setup();
    s.daemon.find("server-blue")!.networks["test_front"] = ["server-blue-front"];
    s.daemon.find("server-blue")!.running = false;
    s.daemon.find("server-blue")!.role = "standby";
    const g = withGreen(s, "leader", ["server-green-front", "server-live"]);
    void g;
    s.state.update({ stage: "idle" });
    await recover(s.deps);
    expect(s.daemon.calls.some((c) => c.method !== "GET")).toBe(false);
  });

  test("an interrupted pre-swap stage, as in 941a, still removes the pack installer", async () => {
    const s = await setup();
    s.daemon.addPlain("test-updater-pack");
    s.state.update({ stage: "installing-pack" });
    await recover(s.deps);
    expect(s.daemon.names()).toEqual(["server-blue"]);
    expect(s.state.get().error?.code).toBe("interrupted");
  });

  test("the state file survives: reloaded from disk it gives the same stage", async () => {
    const s = await setup();
    put(s, { stage: "soaking", soakUntil: "2030-01-01T00:00:00.000Z" });
    const again = stateStore(s.cfg.stateDir);
    expect(again.load()).toMatchObject({ stage: "soaking", live: "blue", idle: "green", commit: NEW_COMMIT });
    void LABEL;
    void OLD_COMMIT;
  });
});
