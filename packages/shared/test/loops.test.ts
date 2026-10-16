import { describe, expect, it } from "vitest";
import { failureSignature, findingFingerprint, normaliseFailure } from "../src/loops.js";

describe("loop signatures (R49, R50)", () => {
  it("gives the same signature to the same failure with different numbers, ids and paths", () => {
    const a = "FAIL src/limit.test.ts (12.3 s)\n  expected 1000 to be 100\n  at /tmp/bm-ws-abc123/x.ts:14:7 run 0b1f2c3d";
    const b = "FAIL src/limit.test.ts (8.1 s)\n  expected 2000 to be 300\n  at /tmp/bm-ws-zzz999/x.ts:22:3 run 9a8b7c6d";
    expect(failureSignature(a)).toBe(failureSignature(b));
    expect(failureSignature(a)).not.toBe(failureSignature("TypeError: cannot read properties of undefined"));
    expect(normaliseFailure("id 3f1c9a2e-1111-4111-8111-111111111111 failed")).toBe("id <id> failed");
  });

  it("fingerprints a finding by file and wording, ignoring case and punctuation", () => {
    expect(findingFingerprint({ path: "src/a.ts", body: "Read this from config!" })).toBe(findingFingerprint({ path: "src/a.ts", body: "read this from  config" }));
    expect(findingFingerprint({ path: "src/a.ts", body: "x" })).not.toBe(findingFingerprint({ path: "src/b.ts", body: "x" }));
  });
});
