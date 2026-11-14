import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harnessVersions, parseVersion } from "../src/harness-versions.js";

describe("harness versions (BOS-305)", () => {
  it("pulls the number out of a --version line", () => {
    expect(parseVersion("2.1.316 (Claude Code)\n")).toBe("2.1.316");
    expect(parseVersion("1.19.3")).toBe("1.19.3");
    expect(parseVersion("no version here")).toBeNull();
  });

  it("collects what answers, reads the adapter pins, and leaves out what fails", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bm-hv-"));
    const packageJson = path.join(dir, "package.json");
    writeFileSync(packageJson, JSON.stringify({ dependencies: { "@agentclientprotocol/codex-acp": "0.9.0", "@agentclientprotocol/claude-agent-acp": "0.8.1" } }));
    const run = async (cmd: string) => {
      if (cmd === "claude") return "2.1.316 (Claude Code)";
      throw new Error("not installed");
    };
    expect(await harnessVersions({ run, packageJson, claudePath: "claude" })).toEqual({ "claude-code": "2.1.316", "codex-acp": "0.9.0", "claude-agent-acp": "0.8.1" });
  });

  it("DR-050: with no ready pack, Claude Code and its adapter are both absent (not crashing), and the adapter version comes from the pack", async () => {
    // The runner package.json no longer carries the Claude adapter (it lives in the pack).
    const dir = mkdtempSync(path.join(tmpdir(), "bm-hv-"));
    const packageJson = path.join(dir, "package.json");
    writeFileSync(packageJson, JSON.stringify({ dependencies: { "@agentclientprotocol/codex-acp": "0.9.0" } }));
    // No CLAUDE_CODE_EXECUTABLE answers (no pack): claude-code is left out, and no adapter version is given.
    const run = async () => {
      throw new Error("not installed");
    };
    expect(await harnessVersions({ run, packageJson, claudePath: "/nonexistent/claude" })).toEqual({ "codex-acp": "0.9.0" });
    // With a ready pack, the adapter's version is passed in and reported.
    expect(await harnessVersions({ run: async (c) => (c === "/opt/bossman-claude/x/node_modules/.bin/claude" ? "2.1.316" : (() => { throw new Error("no"); })()), packageJson, claudePath: "/opt/bossman-claude/x/node_modules/.bin/claude", claudeAdapterVersion: "0.91.0" })).toMatchObject({
      "claude-code": "2.1.316",
      "claude-agent-acp": "0.91.0",
      "codex-acp": "0.9.0",
    });
  });
});
