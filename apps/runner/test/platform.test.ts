import { describe, expect, it } from "vitest";
import { platformFingerprint } from "@boss-man/shared";
import { platformReport } from "../src/platform.js";

describe("the runner's platform report (DR-049 point 1)", () => {
  it("reports the kernel and what the launcher passed for Docker and the OS type", () => {
    const p = platformReport({ BOSSMAN_HOST_DOCKER: "27.0.1", BOSSMAN_HOST_OS: "linux" }, "6.1.0-test");
    expect(p).toEqual({ kernel: "6.1.0-test", dockerVersion: "27.0.1", osType: "linux" });
    expect(platformFingerprint(p)).toBe("6.1.0-test|docker 27.0.1|linux");
  });

  it("says unknown for a runner started by hand, and a different kernel is a different fingerprint", () => {
    const a = platformReport({}, "6.1.0-test");
    expect(a).toEqual({ kernel: "6.1.0-test", dockerVersion: "unknown", osType: "unknown" });
    expect(platformFingerprint(a)).not.toBe(platformFingerprint(platformReport({}, "6.8.0-new")));
  });

  it("keeps odd input short and printable", () => {
    const p = platformReport({ BOSSMAN_HOST_DOCKER: "27\u0000.0\n" + "x".repeat(200), BOSSMAN_HOST_OS: "" }, "k");
    expect(p.dockerVersion.length).toBeLessThanOrEqual(60);
    expect(p.dockerVersion).not.toMatch(/[\u0000\n]/);
    expect(p.osType).toBe("unknown");
  });
});
