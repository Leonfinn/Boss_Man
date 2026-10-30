import { describe, expect, it } from "vitest";
import { createErrorBuffer, formatLogArg, redact } from "../src/services/error-buffer.js";

describe("error buffer", () => {
  it("redacts the secrets an error line can carry", () => {
    expect(redact("Authorization: Bearer abc.def.123")).toBe("Authorization: Bearer [redacted]");
    expect(redact("run token bm_run_abcDEF123")).not.toContain("abcDEF123");
    expect(redact("runner bmr_xyz789")).not.toContain("xyz789");
    expect(redact("key sk-abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(redact("https://user:hunter2@example.com/x")).not.toContain("hunter2");
    expect(redact("https://example.com/x?token=supersecret&x=1")).not.toContain("supersecret");
    expect(redact("GITHUB_TOKEN=ghp_1234567890abcdefghij")).not.toContain("ghp_1234567890abcdefghij");
    expect(redact("DB_PASSWORD=pw123456")).not.toContain("pw123456");
  });

  it("keeps only the most recent lines, oldest dropped", () => {
    const buf = createErrorBuffer(3);
    for (const line of ["one", "two", "three", "four"]) buf.push(line);
    expect(buf.recent()).toEqual(["two", "three", "four"]);
    expect(buf.recent(1)).toEqual(["four"]);
  });

  it("turns an Error or a context object into one line", () => {
    expect(formatLogArg(new Error("boom"))).toContain("boom");
    expect(formatLogArg({ err: "x" })).toBe('{"err":"x"}');
  });
});
