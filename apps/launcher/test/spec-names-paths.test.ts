// BOS-2134 (background lane): the launcher's name and path helpers. Each one is pure and only
// interpolates a slug or a stack, so these tests pin their exact output for made-up values.
// No host paths here: /data/example stands in for BOSSMAN_DATA.
// BOS-2363 (background lane) adds the image helpers: the installed image when given, else the
// stack's built one.
import { describe, expect, it } from "vitest";
import {
  claudePackVolume,
  companyDir,
  containerName,
  guardImageOf,
  listLabel,
  netguardDir,
  netguardName,
  previousRunnerImage,
  runnerImageOf,
  type LauncherConfig,
} from "../src/spec.js";

const cfg = (dataRoot: string, extra: Partial<LauncherConfig> = {}): LauncherConfig => ({
  dataRoot,
  network: "boss-man_default",
  serverUrl: "ws://server:3100/api/runner/connect",
  memoryBytes: 4 * 1024 ** 3,
  pidsLimit: 4096,
  ...extra,
});

describe("launcher names and paths (BOS-2134)", () => {
  describe("claudePackVolume", () => {
    it("uses the shared volume for the one stack", () => {
      expect(claudePackVolume()).toBe("boss-man-claude-pack");
      expect(claudePackVolume("")).toBe("boss-man-claude-pack");
    });

    it("puts a named stack in the volume name", () => {
      expect(claudePackVolume("staging")).toBe("boss-man-staging-claude-pack");
    });
  });

  describe("containerName", () => {
    it("names a runner after its company for the one stack", () => {
      expect(containerName("app-co")).toBe("boss-man-runner-app-co");
    });

    it("prefixes a named stack so two stacks never share a name", () => {
      expect(containerName("app-co", "staging")).toBe("boss-man-staging-runner-app-co");
    });
  });

  describe("netguardName", () => {
    it("names the guard after its company for the one stack", () => {
      expect(netguardName("app-co")).toBe("boss-man-netguard-app-co");
    });

    it("prefixes a named stack", () => {
      expect(netguardName("app-co", "staging")).toBe("boss-man-staging-netguard-app-co");
    });
  });

  describe("previousRunnerImage", () => {
    it("names the rollback image for the one stack", () => {
      expect(previousRunnerImage()).toBe("boss-man-runner:previous");
      expect(previousRunnerImage("")).toBe("boss-man-runner:previous");
    });

    it("names the rollback image for a named stack", () => {
      expect(previousRunnerImage("staging")).toBe("boss-man-staging-runner:previous");
    });
  });

  describe("listLabel", () => {
    it("lists every launcher container when no stack is named", () => {
      expect(listLabel()).toBe("boss-man.launcher=1");
      expect(listLabel("")).toBe("boss-man.launcher=1");
    });

    it("lists only the named stack's containers", () => {
      expect(listLabel("staging")).toBe("boss-man.stack=staging");
    });
  });

  describe("companyDir", () => {
    it("puts a company under the data root's companies folder", () => {
      expect(companyDir(cfg("/data/example"), "app-co")).toBe("/data/example/companies/app-co");
    });

    it("normalises a trailing slash on the data root", () => {
      expect(companyDir(cfg("/data/example/"), "app-co")).toBe("/data/example/companies/app-co");
    });
  });

  describe("netguardDir", () => {
    it("puts the allow list under the company folder's netguard folder", () => {
      expect(netguardDir(cfg("/data/example"), "app-co")).toBe("/data/example/companies/app-co/netguard");
    });

    it("normalises a trailing slash on the data root", () => {
      expect(netguardDir(cfg("/data/example/"), "app-co")).toBe("/data/example/companies/app-co/netguard");
    });
  });

  describe("runnerImageOf", () => {
    it("uses the image the install names when given, even for a named stack", () => {
      const image = "ghcr.io/example/boss-man-runner@sha256:0123456789abcdef";
      expect(runnerImageOf(cfg("/data/example", { runnerImage: image }))).toBe(image);
      expect(runnerImageOf(cfg("/data/example", { runnerImage: image, stack: "staging" }))).toBe(image);
    });

    it("falls back to the stack's built image when no image is named", () => {
      expect(runnerImageOf(cfg("/data/example"))).toBe("boss-man-runner:current");
      expect(runnerImageOf(cfg("/data/example", { stack: "staging" }))).toBe("boss-man-staging-runner:current");
    });
  });

  describe("guardImageOf", () => {
    it("uses the image the install names when given, even for a named stack", () => {
      const image = "ghcr.io/example/boss-man-netguard@sha256:0123456789abcdef";
      expect(guardImageOf(cfg("/data/example", { netguardImage: image }))).toBe(image);
      expect(guardImageOf(cfg("/data/example", { netguardImage: image, stack: "staging" }))).toBe(image);
    });

    it("falls back to the stack's built image when no image is named", () => {
      expect(guardImageOf(cfg("/data/example"))).toBe("boss-man-netguard:current");
      expect(guardImageOf(cfg("/data/example", { stack: "staging" }))).toBe("boss-man-staging-netguard:current");
    });
  });
});
