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
});
