// Design test 12 (part): socket group handling, the key, and the install's own configuration.
import { describe, expect, test } from "vitest";
import { loadConfig, UpdaterError } from "../src/config.js";
import { dropToUnprivileged, readKey, socketModeProblem, type Ids } from "../src/startup.js";
import { keyMatches } from "../src/server.js";

function ids(start: number, after = 1000) {
  const log: string[] = [];
  let uid = start;
  const i: Ids = { getuid: () => uid, geteuid: () => uid, setgroups: (g) => void log.push(`groups ${g}`), setgid: (g) => void log.push(`gid ${g}`), setuid: (u) => { log.push(`uid ${u}`); uid = after; } };
  return { i, log };
}

describe("dropping root", () => {
  test("socket group 0 (Docker Desktop): joins group 0, ends as uid 1000", () => {
    const { i, log } = ids(0);
    expect(dropToUnprivileged("/s", i, () => ({ gid: 0, mode: 0o660 }))).toMatch(/group is root \(0\), running as uid 1000/);
    expect(log).toEqual(["groups 0", "gid 0", "uid 1000"]);
  });
  test("another socket group is joined as an extra group", () => {
    const { i, log } = ids(0);
    dropToUnprivileged("/s", i, () => ({ gid: 998, mode: 0o660 }));
    expect(log).toEqual(["groups 998", "gid 1000", "uid 1000"]);
  });
  test("a socket the group cannot write stops with a plain message and keeps root unused", () => {
    const { i, log } = ids(0);
    expect(() => dropToUnprivileged("/s", i, () => ({ gid: 0, mode: 0o640 }))).toThrowError(/not read-write for its group/);
    expect(log).toEqual([]);
    expect(socketModeProblem("/s", { mode: 0o666 })).toBeNull();
  });
  test("if the drop does not end at uid 1000 it stops instead of running as root", () => {
    const { i } = ids(0, 0);
    expect(() => dropToUnprivileged("/s", i, () => ({ gid: 0, mode: 0o660 }))).toThrowError(/stopping instead of running as root/);
  });
  test("already uid 1000: nothing to do", () => {
    const { i, log } = ids(1000);
    expect(dropToUnprivileged("/s", i)).toMatch(/nothing to drop/);
    expect(log).toEqual([]);
  });
});

describe("the key", () => {
  test("missing and short keys refuse to start, in plain words", () => {
    expect(() => readKey("/k", () => { throw new Error("ENOENT"); })).toThrowError(/missing/);
    expect(() => readKey("/k", () => "short")).toThrowError(/too short/);
    expect(readKey("/k", () => `${"k".repeat(40)}\n`)).toBe("k".repeat(40));
  });
  test("comparison is exact", () => {
    const k = "k".repeat(40);
    expect(keyMatches(k, k)).toBe(true);
    expect(keyMatches(`${k}x`, k)).toBe(false);
    expect(keyMatches(k.slice(1), k)).toBe(false);
    expect(keyMatches(undefined, k)).toBe(false);
    expect(keyMatches("", k)).toBe(false);
  });
});

describe("configuration comes from the install, with plain errors", () => {
  const good = { UPDATER_REPO: "o/r", UPDATER_REGISTRY: "ghcr.io/o", UPDATER_INSTALL_LABEL: "a=b", UPDATER_CURRENT_VERSION: "0.1.0", UPDATER_PACK_VOLUME: "v", UPDATER_NETWORK: "n", UPDATER_NAME_PREFIX: "p" };
  test("a complete set loads", () => expect(loadConfig(good).repo).toBe("o/r"));
  test.each(Object.keys(good))("%s missing: stops and names it", (name) => {
    const { [name]: _gone, ...rest } = good as Record<string, string>;
    expect(() => loadConfig(rest)).toThrowError(new RegExp(name));
  });
  test("a repository that is not owner/name is refused (it builds the pinned signing identity)", () => {
    expect(() => loadConfig({ ...good, UPDATER_REPO: "o/r/../x" })).toThrowError(UpdaterError);
    expect(() => loadConfig({ ...good, UPDATER_REPO: "https://evil.example/x" })).toThrowError(UpdaterError);
  });
  test("an unsupported processor is a plain error", () => expect(() => loadConfig({ ...good, UPDATER_ARCH: "riscv64" })).toThrowError(/not supported/));
});
