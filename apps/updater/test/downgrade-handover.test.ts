// Design tests 10 and 11 (941b): the downgrade defence with the standby exception, and the updater's own hand-over.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runMove } from "../src/move.js";
import { createServer } from "../src/server.js";
import { OLD_COMMIT } from "./fake-daemon.js";
import { closeAll, closers, rel, setup } from "./swap-helpers.js";
import { sha } from "./helpers.js";

const KEY = "k".repeat(40);
afterEach(closeAll);

/** The release the standby colour was made for: 0.1.0, server digest sha("5"), the commit the old colour reports. */
const OLD_REL = () => {
  const r = rel({ version: "0.1.0", commit: OLD_COMMIT }) as { images: { name: string; digest: string }[] };
  r.images = r.images.map((i) => (i.name === "boss-man-server" ? { ...i, digest: sha("5") } : i));
  return r;
};

async function withStandby() {
  const s = await setup({ version: "0.1.0", release: OLD_REL() });
  const blue = s.daemon.find("server-blue")!;
  blue.labels["com.bossman.release"] = "0.2.0";
  const green = s.daemon.addLive("green", "0.1.0", { running: false, live: false, digestChar: "5" });
  green.commit = OLD_COMMIT;
  return s;
}

describe("test 10: the downgrade defence, and the standby exception", () => {
  test("an older release that is not the standby's is refused, and nothing is touched", async () => {
    const s = await setup({ version: "0.1.5" });
    s.daemon.find("server-blue")!.labels["com.bossman.release"] = "0.2.0";
    await runMove(s.deps, { version: "0.1.5", serverDigest: sha("7") });
    expect(s.state.get()).toMatchObject({ stage: "failed", error: { code: "downgrade" } });
    expect(s.daemon.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("the standby's own release number with another digest (a replayed old signed release) is refused", async () => {
    const s = await withStandby();
    await runMove(s.deps, { version: "0.1.0", serverDigest: sha("6") });
    expect(s.state.get().error?.code).toBe("downgrade");
    expect(s.daemon.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("the same release is refused as already current", async () => {
    const s = await setup();
    s.daemon.find("server-blue")!.labels["com.bossman.release"] = "0.2.0";
    await runMove(s.deps, { version: "0.2.0", serverDigest: sha("7") });
    expect(s.state.get().error?.code).toBe("already_current");
  });

  test("the standby's release is allowed: the stopped standby starts, is health-checked, takes over; no pull, no backup, no migrate", async () => {
    const s = await withStandby();
    await runMove(s.deps, { version: "0.1.0", serverDigest: sha("5") });
    expect(s.state.get()).toMatchObject({ stage: "done", error: null, restore: true });
    const writes = s.daemon.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
    expect(writes.some((w) => w.includes("/images/create") || w.includes("/exec") || w.includes("migrate") || w.includes("create?name"))).toBe(false);
    expect(writes).toContain("POST /containers/server-green/start");
    expect(s.daemon.holder("server-live")?.name).toBe("server-green");
    expect(s.daemon.find("server-green")).toMatchObject({ running: true, role: "leader" });
    expect(s.daemon.find("server-blue")).toMatchObject({ running: false });
    expect(s.state.get().report?.text).toMatch(/Updated to 0\.1\.0/);
  });

  test("the standby does not come up healthy: it is stopped again, the live colour keeps serving", async () => {
    const s = await withStandby();
    s.daemon.find("server-green")!.healthy = false;
    await runMove(s.deps, { version: "0.1.0", serverDigest: sha("5") });
    expect(s.state.get().error?.code).toBe("colour_unhealthy");
    expect(s.daemon.find("server-green")).toMatchObject({ running: false });
    expect(s.daemon.find("server-blue")).toMatchObject({ running: true, role: "leader" });
    expect(s.daemon.holder("server-live")?.name).toBe("server-blue");
  });
});

describe("test 11: the updater hands over to the next updater", () => {
  const UPDATER = "ghcr.io/leonfinn/boss-man-updater@sha256:" + "9".repeat(64);

  async function start(over: { release?: object } = {}) {
    const s = await setup(over);
    s.daemon.addPlain("updater", { "boss-man.install": "test" }, UPDATER);
    const exited: number[] = [];
    const u = createServer(s.deps, KEY, Promise.resolve(), (c) => void exited.push(c));
    await new Promise<void>((r) => u.server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => u.server.close(() => r())));
    const port = (u.server.address() as AddressInfo).port;
    const post = (digest: unknown, key = KEY) =>
      new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ digest });
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/handover", headers: { authorization: `Bearer ${key}`, "content-length": Buffer.byteLength(body) } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end(body);
      });
    return { ...s, exited, post };
  }

  test("the new updater calls in: names are swapped, the old one will not restart and exits, the result is recorded", async () => {
    const s = await start();
    let status = 0;
    s.daemon.onStart = (name) => {
      if (name === "updater-next") void s.post(sha("4")).then((c) => (status = c));
    };
    await runMove(s.deps, { version: "0.2.0", serverDigest: sha("7") });
    await vi.waitFor(() => expect(s.exited).toEqual([0]));
    expect(status).toBe(200);
    const next = s.daemon.find("updater")!;
    expect(next.image).toBe(`ghcr.io/leonfinn/boss-man-updater@${sha("4")}`);
    expect(next.restart).toBe("unless-stopped");
    expect(next.networks["test_updater"]).toEqual(["updater"]);
    const old = s.daemon.find("updater-old")!;
    expect(old.restart).toBe("no");
    expect(s.state.get().report?.text).toMatch(/updater itself was updated to 0\.2\.0/);
    // The server move finished first; the updater is replaced last.
    const calls = s.daemon.calls.map((c) => c.path);
    expect(calls.indexOf("/containers/create?name=updater-next")).toBeGreaterThan(calls.indexOf("/containers/server-blue/stop?t=60"));
  });

  test("the new updater is made from the release's digest with the same settings, root only to learn the socket's group, the socket the one bind", async () => {
    const s = await start();
    s.daemon.onStart = (name) => void (name === "updater-next" && s.post(sha("4")));
    await runMove(s.deps, { version: "0.2.0", serverDigest: sha("7") });
    const create = s.daemon.calls.find((c) => c.path === "/containers/create?name=updater-next")!.body as { Image: string; User: string; Env: string[]; HostConfig: { Binds: string[]; CapAdd: string[]; CapDrop: string[]; Mounts: { Source: string }[] } };
    expect(create.Image).toBe(`ghcr.io/leonfinn/boss-man-updater@${sha("4")}`);
    expect(create.User).toBe("0:0");
    expect(create.HostConfig.Binds).toEqual(["/var/run/docker.sock:/var/run/docker.sock"]);
    expect(create.HostConfig.CapAdd.sort()).toEqual(["SETGID", "SETUID"]);
    expect(create.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(create.HostConfig.Mounts.map((m) => m.Source)).toEqual(["test_updater-state", "test_updater-key"]);
    expect(create.Env).toContain("UPDATER_CURRENT_VERSION=0.2.0");
    expect(create.Env).toContain("UPDATER_IS_NEXT=1");
    expect(create.Env).toContain("UPDATER_INSTALL_LABEL=boss-man.install=test");
  });

  test("the new updater never calls in: it is removed, the old one keeps running, and 'Updater update failed' is recorded", async () => {
    const s = await start();
    await runMove(s.deps, { version: "0.2.0", serverDigest: sha("7") });
    expect(s.daemon.find("updater-next")).toBeUndefined();
    expect(s.daemon.find("updater")).toMatchObject({ running: true, restart: "unless-stopped" });
    expect(s.daemon.find("updater-old")).toBeUndefined();
    expect(s.exited).toEqual([]);
    expect(s.state.get().stage).toBe("done");
    expect(s.state.get().report).toMatchObject({ level: "problem" });
    expect(s.state.get().report?.text).toMatch(/Updater update failed/);
    // Nothing live was affected: green leads.
    expect(s.daemon.holder("server-live")?.name).toBe("server-green");
  });

  test("the new updater crashes on start: it is removed and the old one carries on", async () => {
    const s = await start();
    s.daemon.failCall = (c) => (c.path.includes("/containers/id") && c.path.endsWith("/start") && s.daemon.find("updater-next") ? { status: 500, body: Buffer.from('{"message":"exec format error"}') } : undefined);
    await runMove(s.deps, { version: "0.2.0", serverDigest: sha("7") });
    expect(s.daemon.find("updater-next")).toBeUndefined();
    expect(s.daemon.find("updater")).toMatchObject({ running: true });
    expect(s.state.get().report?.text).toMatch(/Updater update failed/);
  });

  test("a hand-over call is refused when none is expected, with a wrong digest or without the key", async () => {
    const s = await start();
    expect(await s.post(sha("4"))).toBe(409);
    expect(await s.post(sha("4"), "wrong")).toBe(401);
    s.daemon.onStart = (name) => void (name === "updater-next" && s.post(sha("3")).then((c) => expect(c).toBe(409)));
    await runMove(s.deps, { version: "0.2.0", serverDigest: sha("7") });
    expect(s.exited).toEqual([]);
    expect(s.daemon.find("updater")).toMatchObject({ restart: "unless-stopped" });
  });

  test("an updater already on the release's digest is left alone", async () => {
    const s = await start();
    s.daemon.find("updater")!.image = `ghcr.io/leonfinn/boss-man-updater@${sha("4")}`;
    await runMove(s.deps, { version: "0.2.0", serverDigest: sha("7") });
    expect(s.daemon.calls.some((c) => c.path.includes("updater-next"))).toBe(false);
  });

  test("a release that needs a newer layout updates the updater first and leaves the server move for the new updater", async () => {
    const s = await start({ release: rel({ installLayout: 2 }) });
    s.daemon.onStart = (name) => void (name === "updater-next" && s.post(sha("4")));
    await runMove(s.deps, { version: "0.2.0", serverDigest: sha("7") });
    await vi.waitFor(() => expect(s.exited).toEqual([0]));
    expect(s.state.get()).toMatchObject({ stage: "idle", pending: { version: "0.2.0", serverDigest: sha("7") } });
    // No backup, migration or colour yet.
    expect(s.daemon.calls.some((c) => c.path.includes("/exec") || c.path.includes("create?name=server-") || c.path.includes("migrate"))).toBe(false);
  });
});
