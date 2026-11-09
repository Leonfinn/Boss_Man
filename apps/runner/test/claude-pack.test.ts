// The Claude pack (DR-050, BOS-972): content-addressed folders, the READY marker written only after
// every check passed, a runner that never starts on a not-ready pack and never crashes without one,
// and the installer's fixed order (copy, npm ci, version, canary, then READY).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapterBin, claudeBin, discardDir, installPack, lockHash, markReady, packDirFor, packEnv, packPaths, parseClaudeVersion, readPack, sourceLockHash } from "../src/claude-pack.js";
import { defaultBin } from "../src/session-manager.js";

const roots: string[] = [];
function root() {
  const d = mkdtempSync(path.join(tmpdir(), "bm-pack-"));
  roots.push(d);
  return d;
}
/** A folder that looks like an installed pack: both bins present, READY only when asked. */
function readyPack(rootDir: string, hash: string, version = "2.1.316") {
  const dir = packDirFor(rootDir, hash);
  const p = packPaths(dir);
  mkdirSync(p.nodeModules, { recursive: true });
  mkdirSync(path.dirname(p.claudeBin), { recursive: true });
  writeFileSync(p.claudeBin, "#!/bin/sh\n");
  writeFileSync(p.adapterBin, "#!/bin/sh\n");
  markReady(dir, { version, hash });
  return dir;
}
afterEach(() => {
  for (const d of roots.splice(0)) discardDir(d);
});

const HASH = lockHash('{"lockfileVersion":3}');

describe("the pack folder is content-addressed by its lockfile", () => {
  it("names a folder by the sha256 of the lock, first 24 hex characters", () => {
    expect(HASH).toMatch(/^[0-9a-f]{24}$/);
    expect(lockHash("a")).not.toBe(lockHash("b"));
    expect(lockHash("same")).toBe(lockHash("same"));
    expect(packDirFor("/opt/bossman-claude", HASH)).toBe(`/opt/bossman-claude/${HASH}`);
    expect(() => packDirFor("/opt/bossman-claude", "../etc")).toThrow();
  });

  it("a bumped lock gets a new folder and never reuses the old READY", () => {
    const r = root();
    const old = readyPack(r, HASH, "2.1.316");
    const next = lockHash('{"lockfileVersion":3,"changed":true}');
    expect(next).not.toBe(HASH);
    // The old folder stays ready and usable; the new hash has no folder at all yet.
    expect(readPack(r, HASH)).toMatchObject({ ready: true, dir: old, version: "2.1.316" });
    expect(readPack(r, next)).toMatchObject({ ready: false });
    expect(existsSync(packDirFor(r, next))).toBe(false);
  });
});

describe("a pack is ready only when its READY marker and both binaries are there", () => {
  it("is not ready with no folder, no READY marker, or a marker for another pack", () => {
    const r = root();
    expect(readPack(r, HASH)).toMatchObject({ ready: false });
    // A folder with node_modules but no READY (a crash mid-install): not ready, never crashes.
    const dir = packDirFor(r, HASH);
    mkdirSync(packPaths(dir).nodeModules, { recursive: true });
    expect(readPack(r, HASH)).toMatchObject({ ready: false, reason: expect.stringMatching(/READY/) });
    // A READY marker for a different hash is refused.
    readyPack(r, HASH);
    writeFileSync(packPaths(dir).ready, JSON.stringify({ version: "2.1.316", hash: "0".repeat(24), at: new Date().toISOString() }));
    expect(readPack(r, HASH)).toMatchObject({ ready: false, reason: expect.stringMatching(/different pack/) });
  });

  it("is not ready when a READY marker exists but a binary is missing", () => {
    const r = root();
    const dir = readyPack(r, HASH);
    discardDir(packPaths(dir).claudeBin);
    expect(readPack(r, HASH)).toMatchObject({ ready: false, reason: expect.stringMatching(/no claude binary/) });
  });

  it("is ready when the folder is complete, and names the two executables", () => {
    const r = root();
    const dir = readyPack(r, HASH);
    expect(readPack(r, HASH)).toEqual({ ready: true, dir, version: "2.1.316" });
    expect(claudeBin(dir)).toBe(path.join(dir, "node_modules", ".bin", "claude"));
    expect(adapterBin(dir)).toBe(path.join(dir, "node_modules", ".bin", "claude-agent-acp"));
    expect(packEnv({ ready: true, dir })).toEqual({ CLAUDE_CODE_EXECUTABLE: claudeBin(dir), BOSSMAN_CLAUDE_PACK: dir });
    expect(packEnv({ ready: false })).toEqual({});
  });
});

describe("markReady writes atomically (temp then rename)", () => {
  it("leaves no .tmp behind and records version, hash and time", () => {
    const r = root();
    const dir = packDirFor(r, HASH);
    mkdirSync(packPaths(dir).nodeModules, { recursive: true });
    const info = markReady(dir, { version: "2.1.316", hash: HASH, at: "2026-11-09T00:00:00Z" });
    expect(info).toEqual({ version: "2.1.316", hash: HASH, at: "2026-11-09T00:00:00Z" });
    expect(existsSync(`${packPaths(dir).ready}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(packPaths(dir).ready, "utf8"))).toEqual(info);
  });
});

describe("installPack runs the fixed order: copy, npm ci, version, canary, then READY", () => {
  const steps = (order: string[], opts: { version?: string; canary?: boolean; ciFails?: boolean } = {}) => ({
    copySource: (dir: string) => {
      order.push("copy");
      writeFileSync(path.join(dir, "package.json"), "{}");
    },
    npmCi: async (dir: string) => {
      order.push("npmCi");
      if (opts.ciFails) throw new Error("npm ci failed: bad integrity");
      // npm ci lays out node_modules; both bins must exist for the READY marker to be trusted.
      mkdirSync(path.dirname(packPaths(dir).claudeBin), { recursive: true });
      writeFileSync(packPaths(dir).claudeBin, "#!/bin/sh\n");
      writeFileSync(packPaths(dir).adapterBin, "#!/bin/sh\n");
    },
    claudeVersion: async () => {
      order.push("claudeVersion");
      return `${opts.version ?? "2.1.316"} (Claude Code)`;
    },
    canary: async () => {
      order.push("canary");
      return opts.canary ?? true;
    },
  });

  it("installs, checks the version and the canary, and only then marks ready", async () => {
    const r = root();
    const order: string[] = [];
    const out = await installPack({ root: r, hash: HASH, version: "2.1.316", steps: steps(order) });
    expect(order).toEqual(["copy", "npmCi", "claudeVersion", "canary"]);
    expect(out).toMatchObject({ installed: true, version: "2.1.316" });
    expect(readPack(r, HASH)).toMatchObject({ ready: true, version: "2.1.316" });
  });

  it("refuses a version that isn't the pin, and writes no READY", async () => {
    const r = root();
    await expect(installPack({ root: r, hash: HASH, version: "2.1.316", steps: steps([], { version: "9.9.9" }) })).rejects.toThrow(/pinned/);
    expect(readPack(r, HASH)).toMatchObject({ ready: false });
    expect(existsSync(packDirFor(r, HASH))).toBe(false); // the half-made folder is discarded
  });

  it("refuses a failed canary, and writes no READY", async () => {
    const r = root();
    await expect(installPack({ root: r, hash: HASH, version: "2.1.316", steps: steps([], { canary: false }) })).rejects.toThrow(/canary failed/);
    expect(readPack(r, HASH)).toMatchObject({ ready: false });
  });

  it("refuses a failed npm ci (a tampered package), and writes no READY", async () => {
    const r = root();
    await expect(installPack({ root: r, hash: HASH, version: "2.1.316", steps: steps([], { ciFails: true }) })).rejects.toThrow(/integrity/);
    expect(readPack(r, HASH)).toMatchObject({ ready: false });
  });

  it("is idempotent: a ready folder is left alone, so a re-run is cheap", async () => {
    const r = root();
    const order: string[] = [];
    await installPack({ root: r, hash: HASH, version: "2.1.316", steps: steps(order) });
    order.length = 0;
    const again = await installPack({ root: r, hash: HASH, version: "2.1.316", steps: steps(order) });
    expect(again.installed).toBe(false);
    expect(order).toEqual([]);
  });
});

describe("source and version helpers", () => {
  it("reads the shipped lockfile's hash from the source folder, and errors when it's missing", () => {
    const r = root();
    writeFileSync(path.join(r, "package-lock.json"), '{"lockfileVersion":3}');
    expect(sourceLockHash(r)).toBe(lockHash('{"lockfileVersion":3}'));
    expect(() => sourceLockHash(path.join(r, "nope"))).toThrow(/no lockfile/);
  });

  it("parses the version out of claude --version", () => {
    expect(parseClaudeVersion("2.1.316 (Claude Code)\n")).toBe("2.1.316");
    expect(parseClaudeVersion("no version")).toBeNull();
  });
});

describe("a runner with no pack reports Claude absent, not a missing module", () => {
  it("defaultBin for claude with no adapter says Claude isn't installed, in plain words", () => {
    expect(() => defaultBin("claude")).toThrow(/Claude Code isn't installed on this runner/);
    // Given the pack's adapter path (as main.ts passes from a ready pack), it is used as is.
    expect(defaultBin("claude", "/opt/bossman-claude/x/node_modules/.bin/claude-agent-acp")).toBe("/opt/bossman-claude/x/node_modules/.bin/claude-agent-acp");
    expect(defaultBin("opencode")).toBe("opencode");
  });
});

describe("the pack in the repo", () => {
  it("pins exact versions and every package carries an integrity hash", () => {
    const packDir = path.join(__dirname, "..", "claude-pack");
    const pkg = JSON.parse(readFileSync(path.join(packDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@anthropic-ai/claude-code"]).toBe("2.1.316");
    expect(pkg.dependencies["@agentclientprotocol/claude-agent-acp"]).toBe("0.91.0");
    const lock = JSON.parse(readFileSync(path.join(packDir, "package-lock.json"), "utf8")) as { lockfileVersion: number; packages: Record<string, { integrity?: string; resolved?: string }> };
    expect(lock.lockfileVersion).toBe(3);
    // npm ci refuses a package whose bytes don't match its integrity hash: every resolved package must have one.
    const missing = Object.entries(lock.packages).filter(([k, v]) => k && v.resolved && !v.integrity).map(([k]) => k);
    expect(missing).toEqual([]);
  });
});
