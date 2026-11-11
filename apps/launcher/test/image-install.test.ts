import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "../src/setup.js";
import { containerSpec, netguardSpec, parseImageRef, type LauncherConfig } from "../src/spec.js";
import { dropToUnprivileged, hostPathOfMount } from "../src/startup.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "bm-setup-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const base: LauncherConfig = { dataRoot: "/data", network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4 * 1024 ** 3, pidsLimit: 4096 };
const DIGEST = `sha256:${"a".repeat(64)}`;

describe("setup", () => {
  it("makes the master key and database password once, and a second run changes nothing", () => {
    const dir = tmp();
    const dbDir = tmp();
    const owner: string[] = [];
    const chown = (f: string, uid: number, gid: number) => owner.push(`${path.basename(f)} ${uid}:${gid}`);
    expect(runSetup(dir, dbDir, chown)).toEqual({ created: ["master.key", "db_password"], kept: [] });
    const key = readFileSync(path.join(dir, "master.key"), "utf8");
    const pw = readFileSync(path.join(dbDir, "db_password"), "utf8");
    expect(Buffer.from(key.trim(), "base64")).toHaveLength(32);
    expect(pw.trim()).toMatch(/^[0-9a-f]{48}$/);
    // The master key stays out of the database's folder; the password file is readable by the database's group (999) and not by others.
    expect(statSync(path.join(dir, "master.key")).mode & 0o777).toBe(0o400);
    expect(statSync(path.join(dbDir, "db_password")).mode & 0o777).toBe(0o440);
    expect(existsSync(path.join(dbDir, "master.key"))).toBe(false);
    expect(existsSync(path.join(dir, "db_password"))).toBe(false);
    expect(owner).toEqual(["master.key 1000:1000", "db_password 1000:999"]);
    expect(runSetup(dir, dbDir, chown)).toEqual({ created: [], kept: ["master.key", "db_password"] });
    expect(readFileSync(path.join(dir, "master.key"), "utf8")).toBe(key);
    expect(readFileSync(path.join(dbDir, "db_password"), "utf8")).toBe(pw);
    expect(owner).toHaveLength(2);
  });
  it("keeps a master key the owner already has, and makes only what is missing", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "master.key"), "mine\n");
    expect(runSetup(dir, tmp(), () => {})).toEqual({ created: ["db_password"], kept: ["master.key"] });
    expect(readFileSync(path.join(dir, "master.key"), "utf8")).toBe("mine\n");
  });
  it("refuses a folder that is not there", () => {
    expect(() => runSetup(path.join(tmp(), "nope"), tmp())).toThrow(/not a folder/);
    expect(() => runSetup(tmp(), path.join(tmp(), "nope"))).toThrow(/not a folder/);
  });
});

describe("dropToUnprivileged", () => {
  const fake = (uid: number) => {
    const calls: string[] = [];
    return { calls, ids: { getuid: () => uid, setgroups: (g: number[]) => calls.push(`groups ${g}`), setgid: (g: number) => calls.push(`gid ${g}`), setuid: (u: number) => calls.push(`uid ${u}`) } };
  };
  it("joins the socket's group, then drops gid and uid in that order", () => {
    const f = fake(0);
    dropToUnprivileged("/s", f.ids, () => ({ gid: 998 }));
    expect(f.calls).toEqual(["groups 998", "gid 1000", "uid 1000"]);
  });
  it("does nothing when it already is not root (the build install)", () => {
    const f = fake(1000);
    dropToUnprivileged("/s", f.ids, () => ({ gid: 998 }));
    expect(f.calls).toEqual([]);
  });
  it("never gives root's group back", () => {
    const f = fake(0);
    dropToUnprivileged("/s", f.ids, () => ({ gid: 0 }));
    expect(f.calls[0]).toBe("groups ");
  });
});

describe("where the data folder is on the host", () => {
  it("reads it from this container's own mount", () => {
    expect(hostPathOfMount({ Mounts: [{ Destination: "/run/x", Source: "/a" }, { Destination: "/data", Source: "/var/lib/docker/volumes/v/_data" }] } as never, "/data/")).toBe("/var/lib/docker/volumes/v/_data");
  });
  it("says so when there is no mount", () => {
    expect(() => hostPathOfMount({ Mounts: [] } as never, "/data")).toThrow(/BOSSMAN_DATA_HOST/);
    expect(() => hostPathOfMount(null, "/data")).toThrow();
  });
});

describe("image names and host paths in the specs", () => {
  it("default to today's tags and paths", () => {
    const s = containerSpec(base, "acme");
    expect(s.Image).toBe("boss-man-runner:current");
    expect(s.HostConfig.Binds[0]).toBe("/data/companies/acme/workspaces:/home/node/workspaces");
    expect(netguardSpec(base, "acme", "abc").Image).toBe("boss-man-netguard:current");
  });
  it("use the digest images and the host's path for binds when given", () => {
    const cfg = { ...base, hostDataRoot: "/var/lib/docker/volumes/v/_data", runnerImage: `ghcr.io/o/boss-man-runner@${DIGEST}`, netguardImage: `ghcr.io/o/boss-man-netguard@${DIGEST}` };
    const s = containerSpec(cfg, "acme");
    expect(s.Image).toBe(cfg.runnerImage);
    expect(s.HostConfig.Binds).toContain("/var/lib/docker/volumes/v/_data/companies/acme/runner.token:/run/secrets/runner_token:ro");
    expect(s.HostConfig.Binds.every((b) => b.startsWith("/var/lib/docker/volumes/v/_data/"))).toBe(true);
    const g = netguardSpec(cfg, "acme", "abc");
    expect(g.Image).toBe(cfg.netguardImage);
    expect(g.HostConfig.Binds).toEqual(["/var/lib/docker/volumes/v/_data/companies/acme/netguard:/etc/netguard:ro"]);
  });
  it("accepts only image names", () => {
    expect(parseImageRef("X", "")).toBeUndefined();
    expect(parseImageRef("X", `ghcr.io/o/i@${DIGEST}`)).toBe(`ghcr.io/o/i@${DIGEST}`);
    expect(() => parseImageRef("X", "-v /:/h evil")).toThrow();
    expect(() => parseImageRef("X", "Image With Space")).toThrow();
  });
});
