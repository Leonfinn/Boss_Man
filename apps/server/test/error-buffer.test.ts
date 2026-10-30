import { describe, expect, it } from "vitest";
import { createErrorBuffer, logMessage, redact } from "../src/services/error-buffer.js";

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
    expect(redact('{"password":"hunter2","apiKey":"sk-123456789"}')).not.toContain("hunter2");
    expect(redact('{"apiKey":"sk-123456789"}')).not.toContain("sk-123456789");
    expect(redact("cookie bm_session=abc123secret")).not.toContain("abc123secret");
    expect(redact("Cookie: bm_session=abc123secret")).not.toContain("abc123secret");
  });

  it("drops a query and its parameters from a drizzle message", () => {
    const line = 'Failed query: select * from tickets where id = $1 params: ["B Co private plan: acquire Acme"]';
    expect(redact(line)).not.toContain("B Co private plan");
    expect(redact(line)).not.toContain("acquire Acme");
    expect(redact(line)).not.toContain("select * from tickets");
  });

  it("keeps only the most recent lines, oldest dropped", () => {
    const buf = createErrorBuffer(3, () => new Date("2026-01-01T00:00:00Z"));
    for (const line of ["one", "two", "three", "four"]) buf.push(line);
    expect(buf.recent().map((e) => e.message)).toEqual(["two", "three", "four"]);
    expect(buf.recent(1)).toEqual([{ at: "2026-01-01T00:00:00.000Z", message: "four" }]);
    expect(buf.count()).toBe(3);
  });

  it("keeps the logged message, never an Error's message, stack, query or params", () => {
    const err = Object.assign(new Error("Failed query: select 1 params: [\"other company\"]"), {
      query: "select 1",
      params: ["other company"],
    });
    expect(logMessage([{ err }, "run-ended handling failed"])).toBe("run-ended handling failed");
    expect(logMessage([err])).toBe("Error");
    expect(logMessage([{ err }])).toBeNull();
    expect(logMessage(["a plain message"])).toBe("a plain message");
  });
});
