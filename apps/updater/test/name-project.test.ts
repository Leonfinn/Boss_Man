// BOS-2804: container names follow the compose project (two image installs can share a Docker host), and an install made with the
// old fixed names converges to the new ones through the updates it already makes. Against FakeDaemon, virtual clock.
import { afterEach, describe, expect, test } from "vitest";
import { ALLOWED_CALLS } from "../src/docker.js";
import { loadConfig } from "../src/config.js";
import { converge, firstStart } from "../src/firststart.js";
import { runMove } from "../src/move.js";
import { colourName, launcherSpec } from "../src/spec.js";
import { FakeDaemon, HELPER_CFG, swapConfig } from "./fake-daemon.js";
import { closeAll, ins, setup } from "./swap-helpers.js";
import { sha } from "./helpers.js";

afterEach(closeAll);

const CFG = { ...HELPER_CFG, UPDATER_NAME_PROJECT: "acme" };
const names = (d: FakeDaemon) => d.names().sort();

/** Makes a container carry a new name, as if an earlier update had made it under the project's names. */
function rename(d: FakeDaemon, from: string, to: string) {
  const c = d.find(from)!;
  d.containers.delete(from);
  c.name = to;
  d.containers.set(to, c);
}

describe("names from the settings", () => {
  test("no name project: the old fixed names, as before", () => {
    const sw = swapConfig().swap!;
    expect(sw.nameProject).toBeNull();
    expect(sw.selfName).toBe("updater");
    expect(colourName("blue", sw.nameProject)).toBe("server-blue");
  });

  test("a name project: every name follows it, and the aliases the others dial stay as they were", () => {
    const sw = swapConfig(CFG).swap!;
    expect(sw.nameProject).toBe("acme");
    expect(sw.selfName).toBe("acme-updater");
    expect(sw.selfAlias).toBe("updater");
    expect(sw.helpers!.launcherName).toBe("acme-launcher");
    expect(sw.helpers!.launcherAlias).toBe("launcher");
    expect(colourName("green", sw.nameProject)).toBe("acme-server-green");
  });

  test("the launcher's alias is the host of its URL, whatever it is", () => {
    expect(swapConfig({ ...CFG, UPDATER_LAUNCHER_URL: "http://runner-helper:3105/" }).swap!.helpers!.launcherAlias).toBe("runner-helper");
  });

  test("a name project that is not a compose project name is refused at start", () => {
    for (const bad of ["Acme", "-acme", "acme dev", "a/b"]) expect(() => swapConfig({ ...CFG, UPDATER_NAME_PROJECT: bad }), bad).toThrow(/UPDATER_NAME_PROJECT/);
  });

  test("the launcher's own settings cannot carry the pack volume: the updater sets it; an install label line (BOS-2803 install files) is tolerated", () => {
    expect(() => loadConfig({ ...swapEnv(), UPDATER_LAUNCHER_ENV: "BOSSMAN_CLAUDE_PACK_VOLUME=other" })).toThrow(/pack volume/);
    expect(() => loadConfig({ ...swapEnv(), UPDATER_LAUNCHER_ENV: "BOSSMAN_INSTALL_LABEL=a=b" })).not.toThrow();
  });
});

function swapEnv(): Record<string, string> {
  return { ...swapConfig(CFG).rawEnv };
}

describe("the launcher spec ties the launcher's work to this install", () => {
  test("its pack volume is the one the updater fills, and its install label goes on what it makes", async () => {
    const s = await setup({ cfg: CFG });
    const body = launcherSpec(s.cfg, { version: "0.2.0", launcher: sha("1"), runner: sha("3"), netguard: sha("2") });
    expect(body.Env).toContain(`BOSSMAN_CLAUDE_PACK_VOLUME=${s.cfg.packVolume}`);
    expect(body.Env).toContain("BOSSMAN_INSTALL_LABEL=boss-man.install=test");
    expect(body.Env.some((e) => e.startsWith("BOSSMAN_STACK="))).toBe(false);
  });
});

describe("first start under a project name", () => {
  test("the launcher and the first colour are made with the project's names, and the launcher still answers to `launcher`", async () => {
    const s = await setup({ cfg: CFG, live: false });
    s.daemon.onStart = (n) => {
      if (n === "acme-server-blue") s.daemon.find(n)!.role = "leader";
    };
    await firstStart(s.deps);
    expect(names(s.daemon)).toEqual(["acme-launcher", "acme-server-blue"]);
    expect(s.daemon.find("acme-launcher")!.networks["test_launcher"]).toEqual(expect.arrayContaining(["launcher", "acme-launcher"]));
    expect(s.daemon.find("acme-server-blue")!.networks["test_front"]).toEqual(["server-blue-front", "server-live"]);
  });

  test("an install from the old file (old names, no name project) is adopted and nothing is duplicated", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    s.daemon.addLauncher("0.0.9");
    expect(await firstStart(s.deps)).toEqual([]);
    expect(names(s.daemon)).toEqual(["launcher", "server-blue"]);
  });

  test("old-named containers under a new-named updater setting are adopted by label, not duplicated", async () => {
    const s = await setup({ cfg: CFG });
    s.daemon.addLauncher("0.0.9");
    expect(await firstStart(s.deps)).toEqual([]);
    expect(names(s.daemon)).toEqual(["launcher", "server-blue"]);
  });
});

describe("an old install converges to the project's names by the updates it makes", () => {
  test("first update: the idle colour is made under the new name, the old-named live one keeps serving, the launcher is replaced", async () => {
    const s = await setup({ cfg: CFG });
    s.daemon.addLauncher("0.0.9");
    await runMove(s.deps, ins());
    expect(s.state.get().stage).toBe("done");
    expect(s.state.get().error).toBeNull();
    // The old live colour is now the stopped standby under its old name; the new live one has the new name.
    expect(names(s.daemon)).toEqual(["acme-launcher", "acme-server-green", "server-blue"]);
    expect(s.daemon.find("server-blue")!.running).toBe(false);
    expect(s.daemon.holder("server-live")!.name).toBe("acme-server-green");
    const l = s.daemon.find("acme-launcher")!;
    expect(l.networks["test_launcher"]).toEqual(expect.arrayContaining(["launcher", "acme-launcher"]));
    expect(s.daemon.find("launcher")).toBeUndefined();
  });

  test("second update: the old-named standby is removed by its real name and the colour comes back under the new name", async () => {
    const s = await setup({ cfg: CFG, live: false });
    // After the first update: green (new name) serves, blue (old name) is the stopped standby.
    s.daemon.addLive("blue", "0.0.5", { running: false, live: false });
    const green = s.daemon.addLive("green", "0.0.9", { live: true });
    rename(s.daemon, "server-green", "acme-server-green");
    void green;
    s.daemon.addLauncher("0.0.9");
    rename(s.daemon, "launcher", "acme-launcher");
    await runMove(s.deps, ins());
    expect(s.state.get().error).toBeNull();
    expect(names(s.daemon)).toEqual(["acme-launcher", "acme-server-blue", "acme-server-green"]);
    expect(s.daemon.holder("server-live")!.name).toBe("acme-server-blue");
  });

  test("a colour of each name at once (a half-finished earlier move): the one the move replaces goes, never the live one", async () => {
    const s = await setup({ cfg: CFG, live: false });
    s.daemon.addLive("green", "0.0.9", { live: true });
    rename(s.daemon, "server-green", "acme-server-green");
    s.daemon.addLive("blue", "0.0.5", { running: false, live: false });
    await runMove(s.deps, ins());
    expect(names(s.daemon)).toEqual(["acme-launcher", "acme-server-blue", "acme-server-green"]);
    expect(s.daemon.holder("server-live")!.name).toBe("acme-server-blue");
  });

  test("with no name project nothing is renamed: the old names stay through an update", async () => {
    const s = await setup({ cfg: HELPER_CFG });
    s.daemon.addLauncher("0.0.9");
    await runMove(s.deps, ins());
    expect(names(s.daemon)).toEqual(["launcher", "server-blue", "server-green"]);
  });

  test("every Docker call is still on the allow-list", async () => {
    const s = await setup({ cfg: CFG });
    s.daemon.addLauncher("0.0.9");
    await runMove(s.deps, ins());
    for (const c of s.daemon.calls) expect(ALLOWED_CALLS.some((a) => a.method === c.method && a.pattern.test(c.path)), `${c.method} ${c.path}`).toBe(true);
  });
});

describe("the updater's hand-over under both names", () => {
  const reg = "ghcr.io/leonfinn";
  async function handOver(self: string, cfgOver: Record<string, string>) {
    const s = await setup({ cfg: { ...HELPER_CFG, ...cfgOver } });
    s.daemon.addPlain(self, { "boss-man.install": "test" }, `${reg}/boss-man-updater@${sha("5")}`);
    s.daemon.find(self)!.networks = { test_updater: [] };
    s.daemon.addLauncher("0.2.0");
    s.state.update({ currentVersion: "0.2.0", helpers: { release: "0.2.0", status: "moved", note: null } });
    // This updater runs 0.0.9 (its configured release); the state says 0.2.0, so it hands over to the recorded release.
    let handedOver = false;
    // The new updater calls /handover once the old one is waiting for it: wait for the gate to open (a loop with a bound), then run it.
    s.daemon.onStart = (n) => {
      if (n !== `${self}-next`) return;
      void (async () => {
        for (let i = 0; i < 1000 && !s.gate.expecting; i++) await new Promise((r) => setImmediate(r));
        await s.gate.expecting?.run().then(() => (handedOver = true), () => undefined);
      })();
    };
    await converge(s.deps);
    return { s, out: handedOver ? "handed-over" : "not" };
  }

  test("an old install (the updater is called `updater`): the next one takes the name and answers to it", async () => {
    const { s, out } = await handOver("updater", {});
    expect(out).toBe("handed-over");
    expect(s.daemon.find("updater")!.networks["test_updater"]).toEqual(["updater"]);
    expect(s.daemon.find("updater-old")).toBeDefined();
  });

  test("a new install (`acme-updater`): the next one takes that name and still answers to `updater`", async () => {
    const { s, out } = await handOver("acme-updater", { UPDATER_NAME_PROJECT: "acme" });
    expect(out).toBe("handed-over");
    expect(s.daemon.find("acme-updater")!.networks["test_updater"]).toEqual(expect.arrayContaining(["acme-updater", "updater"]));
    expect(s.daemon.find("acme-updater-old")).toBeDefined();
  });
});
