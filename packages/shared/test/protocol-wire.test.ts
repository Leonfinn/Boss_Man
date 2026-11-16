// BOS-1615: pin the runner ↔ server wire helpers in packages/shared/src/protocol.ts.
// There is no protocol test file: only protocol-mcp-required.test.ts pins one schema, so the
// platform fingerprint, the toolchain wording and the id/ref/limit validators had no direct test.
import { describe, expect, it } from "vitest";
import {
  CheckLimits,
  CommitId,
  DEPLOY_REF,
  FENCE_DENIED_PATTERN,
  OriginRef,
  Toolchain,
  platformFingerprint,
  toolchainDifferences,
  toolchainMissing,
} from "../src/protocol.js";

describe("platformFingerprint", () => {
  it("is null while the runner has not reported a platform", () => {
    expect(platformFingerprint(null)).toBeNull();
    expect(platformFingerprint(undefined)).toBeNull();
  });

  it("joins kernel, docker version and OS type in that order", () => {
    expect(platformFingerprint({ kernel: "6.8.0", dockerVersion: "27.0.1", osType: "linux" })).toBe("6.8.0|docker 27.0.1|linux");
  });

  it("still makes a fingerprint from empty fields, so an empty report is not 'no report'", () => {
    expect(platformFingerprint({ kernel: "", dockerVersion: "", osType: "" })).toBe("|docker |");
  });
});

describe("toolchainMissing (one-way tools)", () => {
  it("names a playwright the runner has and the worker lacks, with both versions", () => {
    expect(toolchainMissing({ node: "22" }, { node: "22", playwright: "1.64.1" })).toEqual(["playwright missing here, 1.64.1 on your runner"]);
  });

  it("is empty when the worker has it too", () => {
    expect(toolchainMissing({ playwright: "1.64.1" }, { playwright: "1.64.1" })).toEqual([]);
  });

  it("is empty when the runner lacks it or neither side has it", () => {
    expect(toolchainMissing({}, {})).toEqual([]);
    expect(toolchainMissing({}, { node: "22" })).toEqual([]);
  });

  it("does not compare tools the worker has extra", () => {
    expect(toolchainMissing({ node: "22", playwright: "1.64.1" }, { node: "22" })).toEqual([]);
  });

  it("only names tools in the one-way list, not every missing tool", () => {
    expect(toolchainMissing({}, { node: "22", git: "2.39" })).toEqual([]);
  });
});

describe("toolchainDifferences (compared tools)", () => {
  it("is empty when the tool versions agree", () => {
    expect(toolchainDifferences({ node: "22.11", git: "2.39" }, { node: "22.11", git: "2.39" })).toEqual([]);
  });

  it("names a differing version on both sides", () => {
    expect(toolchainDifferences({ node: "22.11" }, { node: "22.12" })).toEqual(["node 22.11 here, 22.12 on your runner"]);
  });

  it("reports a tool missing on either side", () => {
    expect(toolchainDifferences({}, { git: "2.39" })).toEqual(["git missing here, 2.39 on your runner"]);
    expect(toolchainDifferences({ git: "2.39" }, {})).toEqual(["git 2.39 here, missing on your runner"]);
  });

  it("leaves out chromium, which is shown but never compared", () => {
    expect(toolchainDifferences({ chromium: "120" }, { chromium: "131" })).toEqual([]);
  });

  it("leaves out playwright, which is compared one way by toolchainMissing", () => {
    expect(toolchainDifferences({}, { playwright: "1.64.1" })).toEqual([]);
  });

  it("sorts the wording by tool name whatever order the records are in", () => {
    expect(toolchainDifferences({ zstd: "1", git: "2" }, { zstd: "9", git: "2" })).toEqual(["zstd 1 here, 9 on your runner"]);
    expect(toolchainDifferences({ zstd: "1", git: "3" }, { zstd: "9", git: "2" })).toEqual([
      "git 3 here, 2 on your runner",
      "zstd 1 here, 9 on your runner",
    ]);
  });
});

describe("CommitId", () => {
  it("accepts a full sha1 or sha256 commit id", () => {
    expect(CommitId.safeParse("a".repeat(40)).success).toBe(true);
    expect(CommitId.safeParse("0123456789abcdef".repeat(4)).success).toBe(true);
  });

  it("refuses short ids, uppercase hex and other text", () => {
    for (const bad of ["a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), "HEAD", ""]) {
      expect(CommitId.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("OriginRef", () => {
  it("accepts a full refs/remotes/origin branch", () => {
    for (const ref of ["refs/remotes/origin/main", "refs/remotes/origin/feature/x-1.2", "refs/remotes/origin/a_b"]) {
      expect(OriginRef.safeParse(ref).success, ref).toBe(true);
    }
  });

  it("refuses a local ref, a parent step and the origin HEAD shorthand", () => {
    for (const ref of ["refs/heads/main", "main", "refs/remotes/origin/../main", "refs/remotes/origin/a..b", "refs/remotes/origin/HEAD"]) {
      expect(OriginRef.safeParse(ref).success, ref).toBe(false);
    }
  });

  it("refuses spaces and refs over the length limit", () => {
    expect(OriginRef.safeParse("refs/remotes/origin/two words").success).toBe(false);
    expect(OriginRef.safeParse(`refs/remotes/origin/${"a".repeat(200)}`).success).toBe(false);
    expect(OriginRef.safeParse(`refs/remotes/origin/${"a".repeat(178)}`).success).toBe(true);
  });
});

describe("CheckLimits", () => {
  it("accepts an empty object: both limits are optional", () => {
    expect(CheckLimits.safeParse({}).success).toBe(true);
  });

  it("accepts whole numbers at both ends of each range", () => {
    expect(CheckLimits.safeParse({ threads: 1, memoryMb: 256 }).success).toBe(true);
    expect(CheckLimits.safeParse({ threads: 256, memoryMb: 1_048_576 }).success).toBe(true);
  });

  it("refuses a value outside a range or a fraction", () => {
    for (const bad of [{ threads: 0 }, { threads: 257 }, { threads: 1.5 }, { memoryMb: 255 }, { memoryMb: 1_048_577 }, { memoryMb: 512.5 }]) {
      expect(CheckLimits.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses a limit sent as a string", () => {
    expect(CheckLimits.safeParse({ threads: "4" }).success).toBe(false);
  });
});

describe("Toolchain", () => {
  const print = "a".repeat(64);

  it("accepts a sha256 fingerprint with a tools map", () => {
    expect(Toolchain.safeParse({ fingerprint: print, tools: { node: "22.11" } }).success).toBe(true);
    expect(Toolchain.safeParse({ fingerprint: print, tools: {} }).success).toBe(true);
  });

  it("refuses a fingerprint that is not 64 lowercase hex characters", () => {
    for (const bad of ["a".repeat(63), "A".repeat(64), "g".repeat(64), ""]) {
      expect(Toolchain.safeParse({ fingerprint: bad, tools: {} }).success, bad).toBe(false);
    }
  });

  it("refuses more than 40 tools", () => {
    const tools = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`t${i}`, "1"]));
    expect(Toolchain.safeParse({ fingerprint: print, tools }).success).toBe(false);
    const forty = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`t${i}`, "1"]));
    expect(Toolchain.safeParse({ fingerprint: print, tools: forty }).success).toBe(true);
  });
});

describe("deploy ref and fence denial patterns", () => {
  it("accepts a plain deploy ref with slashes, dots and a plus", () => {
    for (const ref of ["main", "_scratch", "feature/x-1.2", "a+b", "v1.0.0"]) {
      expect(DEPLOY_REF.test(ref), ref).toBe(true);
    }
  });

  it("refuses a ref that starts with a dash, holds a space, is empty or is over 200 characters", () => {
    for (const ref of ["-bad", "two words", "", "a".repeat(201)]) {
      expect(DEPLOY_REF.test(ref), ref).toBe(false);
    }
  });

  it("recognises the ways a fence refuses a write, whatever the case", () => {
    for (const line of ["bash: Permission denied", "Operation not permitted", "open(): EACCES", "readlink EPERM"]) {
      expect(FENCE_DENIED_PATTERN.test(line), line).toBe(true);
    }
  });

  it("does not take ordinary output or a longer word for a denial", () => {
    for (const line of ["content written", "EACCESIBLE", "no error here"]) {
      expect(FENCE_DENIED_PATTERN.test(line), line).toBe(false);
    }
  });
});
