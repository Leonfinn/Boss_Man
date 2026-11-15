import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSocket, runSetup } from "../src/setup.js";
import { containerSpec, netguardSpec, parseImageRef, type LauncherConfig } from "../src/spec.js";
import { dropToUnprivileged, hostPathOfMount, noteSocketGroup } from "../src/startup.js";

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
  const fake = (start: number, stuck = false) => {
    const calls: string[] = [];
    let uid = start;
    return {
      calls,
      ids: { getuid: () => uid, geteuid: () => uid, setgroups: (g: number[]) => calls.push(`groups ${g}`), setgid: (g: number) => calls.push(`gid ${g}`), setuid: (u: number) => { calls.push(`uid ${u}`); if (!stuck) uid = u; } },
    };
  };
  it("joins the socket's group, then drops gid and uid in that order", () => {
    const f = fake(0);
    dropToUnprivileged("/s", f.ids, () => ({ gid: 998, mode: 0o660 }));
    expect(f.calls).toEqual(["groups 998", "gid 1000", "uid 1000"]);
  });
  it("does nothing when it already is not root (the build install)", () => {
    const f = fake(1000);
    dropToUnprivileged("/s", f.ids, () => ({ gid: 998 }));
    expect(f.calls).toEqual([]);
  });
  it("allows socket group 0 (Docker Desktop): uid 1000 with group 0 added, and says so", () => {
    const f = fake(0);
    const line = dropToUnprivileged("/s", f.ids, () => ({ gid: 0, mode: 0o660 }));
    expect(f.calls).toEqual(["groups 0", "gid 0", "uid 1000"]);
    expect(line).toBe("socket group is root (0), running as uid 1000 with that group");
  });
  it("stops instead of staying root when the uid did not change", () => {
    expect(() => dropToUnprivileged("/s", fake(0, true).ids, () => ({ gid: 998, mode: 0o660 }))).toThrow(/stopping instead of running as root/);
  });
  it("stops with a plain message when the socket's group cannot read and write it", () => {
    const f = fake(0);
    expect(() => dropToUnprivileged("/s", f.ids, () => ({ gid: 998, mode: 0o600 }))).toThrow(/not read-write for its group/);
    expect(f.calls).toEqual([]);
  });
});

describe("socket mode and group notes", () => {
  it("setup reports a socket its group cannot use, and skips when none is mounted", () => {
    const here = tmp();
    expect(checkSocket(undefined)).toBeNull();
    expect(checkSocket(path.join(here, "nope"))).toBeNull();
    const f = path.join(here, "sock");
    writeFileSync(f, "");
    expect(checkSocket(f, () => ({ mode: 0o660 }))).toBeNull();
    expect(checkSocket(f, () => ({ mode: 0o600 }))).toMatch(/not read-write for its group/);
  });
  it("says nothing on the first start or an unchanged group, and names both groups when it changed", () => {
    let stored: string | null = null;
    const read = () => stored;
    const write = (_f: string, b: string) => { stored = b; };
    expect(noteSocketGroup("f", 998, read, write)).toBeNull();
    expect(noteSocketGroup("f", 998, read, write)).toBeNull();
    expect(noteSocketGroup("f", 0, read, write)).toBe("socket group changed from 998 to 0 since the last start; the launcher joins the group it sees now");
    expect(stored).toBe("0\n");
  });
  it("the launcher image build fails if group 0 could write a file it ships", () => {
    const df = readFileSync(path.join(__dirname, "../Dockerfile"), "utf8");
    expect(df).toMatch(/find \/app \/NOTICE \/run\/launcher \/data \/config ! -type l -group 0 -perm -g\+w/);
    // The check must come after every step that creates or changes files, and before the container starts.
    expect(df.indexOf("-group 0 -perm -g+w")).toBeGreaterThan(df.indexOf("chown 1000:1000 /data"));
    expect(df.indexOf("-group 0 -perm -g+w")).toBeLessThan(df.indexOf("CMD"));
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
    // Every bind names a host path, except the Claude pack, which is a named volume (shared, read-only).
    expect(s.HostConfig.Binds.every((b) => b.startsWith("/var/lib/docker/volumes/v/_data/") || b === "boss-man-claude-pack:/opt/bossman-claude:ro")).toBe(true);
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
