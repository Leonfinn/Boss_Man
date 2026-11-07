import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostFactsService } from "../src/services/host-facts.js";
import { checkAsk } from "../src/services/decisions.js";
import { fillHostTokens, hostTokensIn, sh, step as stepText } from "../src/services/steps.js";

// Host facts (BOS-427): what the host recorded about itself, read from outbox/host.json.

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function withHost(host: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-hostfacts-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "outbox"), { recursive: true });
  await writeFile(path.join(dir, "outbox", "host.json"), typeof host === "string" ? host : JSON.stringify(host));
  return dir;
}

describe("hostFactsService", () => {
  it("reads the host's name, login and folder ownership", async () => {
    const dir = await withHost({ version: 1, name: "nas01", writtenAt: "2026-11-05T00:00:00Z", login: "leon", ownership: [{ path: "/mnt/backups", owner: "root", group: "root", mode: "700" }] });
    const hosts = await hostFactsService({ dir }).hosts();
    expect(hosts).toEqual([{ name: "nas01", login: "leon", ownership: [{ path: "/mnt/backups", owner: "root", group: "root", mode: "700" }] }]);
  });

  it("leaves the login out when the host didn't record one", async () => {
    const dir = await withHost({ version: 1, name: "nas01", writtenAt: "2026-11-05T00:00:00Z", ownership: [] });
    expect(await hostFactsService({ dir }).hosts()).toEqual([{ name: "nas01", ownership: [] }]);
  });

  it("treats a missing file, half-written JSON, a wrong version or a bad mode as no facts", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "bm-hostfacts-"));
    dirs.push(empty);
    await mkdir(path.join(empty, "outbox"), { recursive: true });
    expect(await hostFactsService({ dir: empty }).hosts()).toEqual([]);
    expect(await hostFactsService({}).hosts()).toEqual([]);
    for (const bad of ["{not json", { version: 2, name: "nas01", writtenAt: "x" }, { version: 1, name: "", writtenAt: "x" }, { version: 1, name: "nas01", writtenAt: "x", ownership: [{ path: "relative", owner: "root", group: "root", mode: "700" }] }, { version: 1, name: "nas01", writtenAt: "x", ownership: [{ path: "/b", owner: "root", group: "root", mode: "abc" }] }])
      expect(await hostFactsService({ dir: await withHost(bad) }).hosts()).toEqual([]);
  });

  it("never reads the contents of a folder: only owner, group and mode are kept", async () => {
    const dir = await withHost({ version: 1, name: "nas01", writtenAt: "2026-11-05T00:00:00Z", ownership: [{ path: "/mnt/secrets", owner: "1000", group: "1000", mode: "700" }] });
    const [h] = await hostFactsService({ dir }).hosts();
    expect(h!.ownership[0]).toEqual({ path: "/mnt/secrets", owner: "1000", group: "1000", mode: "700" });
  });

  it("keeps a folder's role, and the strictest one when it has several (BOS-541)", async () => {
    const dir = await withHost({
      version: 1,
      name: "nas01",
      writtenAt: "2026-11-05T00:00:00Z",
      login: "leon",
      ownership: [
        { path: "/mnt/bm", owner: "root", group: "root", mode: "755", roles: ["install", "backups"] },
        { path: "/srv/boss-man/data", owner: "1000", group: "1000", mode: "700", roles: ["data"] },
        { path: "/mnt/bm/deployer", owner: "root", group: "root", mode: "755", role: "deployer" },
      ],
    });
    const [h] = await hostFactsService({ dir }).hosts();
    // The install folder is also where backups live by default: R6 must read it as backups.
    expect(h!.ownership[0]).toEqual({ path: "/mnt/bm", owner: "root", group: "root", mode: "755", role: "backups" });
    expect(h!.ownership[1]!.role).toBe("data");
    expect(h!.ownership[2]!.role).toBe("deployer");
  });

  it("still reads a record with no roles, and a bad role is no facts at all", async () => {
    const dir = await withHost({ version: 1, name: "nas01", writtenAt: "2026-11-05T00:00:00Z", ownership: [{ path: "/mnt/backups", owner: "root", group: "root", mode: "700" }] });
    const [h] = await hostFactsService({ dir }).hosts();
    expect(h!.ownership[0]).toEqual({ path: "/mnt/backups", owner: "root", group: "root", mode: "700" });
    const bad = await withHost({ version: 1, name: "nas01", writtenAt: "x", ownership: [{ path: "/b", owner: "root", group: "root", mode: "700", roles: ["admin"] }] });
    expect(await hostFactsService({ dir: bad }).hosts()).toEqual([]);
  });
});

// BOS-419 slice 2: the settings record, owner confirmation and the add-on merge.
import { openPglite } from "../src/db/client.js";
import { mergeHostAddons, unknownAddons } from "../src/services/addons.js";
import { flattenHostRecord } from "../src/services/host-facts.js";

const REPORT = {
  version: 1, name: "box1", writtenAt: "2026-11-07T08:00:00Z", ownership: [],
  repo: { origin: "ssh", originHost: "github.com", embeddedCredentials: false, probe: "ok", probedAt: "2026-11-07T07:30:00Z" },
  paths: { install: "/opt/bm", src: "/opt/bm/src", deployer: "/opt/bm/deployer" },
  compose: { files: ["docker-compose.yml"], bluegreen: true, liveColour: "blue" },
  network: { addresses: ["192.168.1.5"], ports: { BOSSMAN_HOST_PORT: "3100" } },
  memory: { totalKb: 8000000, availableKb: 4000000 },
  addons: { tailscale: "running", ntfy: "not_set_up", penpot: "stopped" },
  checks: { restart_counts: { max: 0 } },
};

describe("host facts settings record (BOS-419)", () => {
  it("flattens the allowlisted fields and ignores a malformed section", async () => {
    const dir = await withHost({ ...REPORT, memory: { totalKb: "lots" } });
    const r = (await hostFactsService({ dir }).read())!;
    const flat = flattenHostRecord(r);
    expect(flat["repo.origin"]).toBe("ssh");
    expect(flat["network.port.BOSSMAN_HOST_PORT"]).toBe("3100");
    expect(flat["compose.liveColour"]).toBe("blue");
    expect(flat["check.restart_counts.max"]).toBe("0");
    expect(flat["memory.totalKb"]).toBeUndefined();
    expect(await hostFactsService({ dir }).hosts()).toHaveLength(1);
  });

  it("stores facts with their source, keeps an owner fact, records a conflict, and drops what the host stops reporting", async () => {
    const { db, close } = await openPglite();
    const dir = await withHost(REPORT);
    const svc = hostFactsService({ dir, db, now: () => new Date("2026-11-07T08:01:00Z") });
    const rec = await svc.sync();
    expect(rec.facts["compose.liveColour"]).toEqual({ value: "blue", source: "host", at: "2026-11-07T08:00:00Z" });
    expect(await svc.value("memory.totalKb")).toBe("8000000");
    expect(await svc.value("nope")).toBeNull();

    await svc.confirm("network.publicAddress", "box.example.com");
    await expect(svc.confirm("compose.liveColour", "green")).rejects.toThrow(/host reports/);
    expect((await svc.sync()).facts["network.publicAddress"]).toMatchObject({ value: "box.example.com", source: "owner" });

    // The host starts reporting that key with a different value: host wins, the disagreement is kept.
    await writeFile(path.join(dir, "outbox", "host.json"), JSON.stringify({ ...REPORT, network: { addresses: [], ports: {} }, extra: 1 }));
    const after = await svc.sync();
    expect(after.facts["network.port.BOSSMAN_HOST_PORT"]).toBeUndefined();
    expect(after.facts["network.publicAddress"]?.source).toBe("owner");
    await close();
  });

  it("merges host add-on states with the server's own, keeping the worse", () => {
    const own = unknownAddons("test");
    own.ntfy = { state: "running", since: null, source: "x" };
    own.tailscale = { state: "stopped", since: null, source: "x" };
    const m = mergeHostAddons(own, { tailscale: "running", ntfy: "stopped", penpot: "running", bogus: "running" }, "t");
    expect(m.tailscale.state).toBe("stopped");
    expect(m.ntfy.state).toBe("stopped");
    expect(m.penpot.state).toBe("running");
  });
});

describe("{{host.…}} tokens in card steps", () => {
  it("fills known facts, names missing ones and refuses values that would break a command block", () => {
    const vals = { "paths.src": "/srv/bm/src", "bad.nl": "a\nb", "bad.tick": "a`b" };
    expect(fillHostTokens(["cd {{host.paths.src}} && ls {{ host.paths.src }}"], vals)).toEqual({ steps: ["cd /srv/bm/src && ls /srv/bm/src"], missing: [] });
    const r = fillHostTokens(["{{host.network.publicAddress}}", "{{host.bad.nl}} {{host.bad.tick}}", "{{other}}"], vals);
    expect(r.missing.sort()).toEqual(["bad.nl", "bad.tick", "network.publicAddress"]);
    expect(r.steps[2]).toBe("{{other}}");
    expect(hostTokensIn(["{{host.a.b}} {{host.a.b}}", "x"])).toEqual(["a.b"]);
  });

  it("checkAsk fills the token, refuses a missing fact, and still refuses tokens when it has no facts", () => {
    const tried = "Checked the host from the runner; agents have no access to the owner's machine.";
    const step = stepText("Open the source folder:", sh("cd {{host.paths.src}}", { host: "nas01", as: "root" }));
    const ok = checkAsk({ triedFirst: tried, steps: [step], hostValues: { "paths.src": "/srv/bm/src" } });
    expect(ok.error).toBeNull();
    expect(ok.steps?.[0]).toContain("cd /srv/bm/src");
    const miss = checkAsk({ triedFirst: tried, steps: [step], hostValues: {} });
    expect(miss.error).toContain("{{host.paths.src}}");
    expect(checkAsk({ triedFirst: tried, steps: [step] }).error).toContain("{{host.paths.src}}");
  });

  it("valuesFor reads the record only when a step has a token", async () => {
    const svc = hostFactsService({});
    expect(await svc.valuesFor(["no token"])).toBeUndefined();
    expect(await svc.valuesFor(["{{host.x}}"])).toEqual({});
  });
});
