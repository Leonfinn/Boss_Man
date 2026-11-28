// BOS-2804: an image install owns one pack volume and its label is on everything the launcher makes, so a second install on the same
// Docker host does not share them and removing an install by label takes its runners, guards and pack installer with it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packInstallerSpec } from "../src/claude-pack.js";
import { claudePackVolumeOf, containerSpec, netguardSpec, parseInstallLabel, parsePackVolume, type LauncherConfig } from "../src/spec.js";

const config = (over: Partial<LauncherConfig> = {}): LauncherConfig => ({ dataRoot: mkdtempSync(path.join(tmpdir(), "bm-names-")), network: "acme_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4 * 1024 ** 3, pidsLimit: 4096, ...over });

describe("the pack volume an install owns", () => {
  it("is the stack's own name when none is given (source installs are unchanged)", () => {
    expect(claudePackVolumeOf(config())).toBe("boss-man-claude-pack");
    expect(claudePackVolumeOf(config({ stack: "staging" }))).toBe("boss-man-staging-claude-pack");
  });

  it("is the install's volume when it is given: the runner reads it and the installer fills it, one volume", () => {
    const cfg = config({ packVolume: "acme_claude-pack" });
    const runner = containerSpec(cfg, "app-co");
    expect(runner.HostConfig.Binds).toContain("acme_claude-pack:/opt/bossman-claude:ro");
    expect(runner.HostConfig.Binds!.some((b) => b.startsWith("boss-man-claude-pack:"))).toBe(false);
    expect(packInstallerSpec(cfg, "app-co").HostConfig.Mounts).toEqual([{ Type: "volume", Source: "acme_claude-pack", Target: "/opt/bossman-claude" }]);
  });

  it("is parsed from the environment: a volume name, or nothing", () => {
    expect(parsePackVolume(undefined)).toBeUndefined();
    expect(parsePackVolume(" acme_claude-pack ")).toBe("acme_claude-pack");
    expect(() => parsePackVolume("/etc")).toThrow(/BOSSMAN_CLAUDE_PACK_VOLUME/);
  });
});

describe("the install label", () => {
  it("is parsed as key=value, or nothing", () => {
    expect(parseInstallLabel(undefined)).toBeUndefined();
    expect(parseInstallLabel("com.bossman.install=acme")).toBe("com.bossman.install=acme");
    expect(() => parseInstallLabel("nonsense")).toThrow(/BOSSMAN_INSTALL_LABEL/);
  });

  it("is on the runner, the guard and the pack installer, and absent when not given", () => {
    const cfg = config({ installLabel: "com.bossman.install=acme" });
    const label = (spec: { Labels: object }) => (spec.Labels as Record<string, string>)["com.bossman.install"];
    expect(label(containerSpec(cfg, "app-co"))).toBe("acme");
    expect(label(netguardSpec(cfg, "app-co", "abc"))).toBe("acme");
    expect(label(packInstallerSpec(cfg, "app-co"))).toBe("acme");
    expect(label(containerSpec(config(), "app-co"))).toBeUndefined();
  });
});
