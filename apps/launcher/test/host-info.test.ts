// The runner has no Docker socket, so the launcher passes it the daemon's version and OS type (DR-049 point 1).
import { describe, expect, it } from "vitest";
import { containerSpec, type LauncherConfig } from "../src/spec.js";

const base: LauncherConfig = { dataRoot: "/mnt/data", network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4 * 1024 ** 3, pidsLimit: 4096 };

describe("the runner's platform environment", () => {
  it("passes the daemon's Docker version and OS type", () => {
    const env = containerSpec(base, "acme", undefined, { dockerVersion: "27.0.1", osType: "linux" }).Env;
    expect(env).toContain("BOSSMAN_HOST_DOCKER=27.0.1");
    expect(env).toContain("BOSSMAN_HOST_OS=linux");
  });
  it("passes nothing when the daemon wouldn't say", () => {
    const env = containerSpec(base, "acme", undefined, null).Env;
    expect(env.some((e) => e.startsWith("BOSSMAN_HOST_"))).toBe(false);
  });
});
