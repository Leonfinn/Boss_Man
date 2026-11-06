import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostFactsService } from "../src/services/host-facts.js";

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
