import { describe, expect, it } from "vitest";
import { validTimeZone } from "../src/workingHours.js";

describe("working hours: valid time zones", () => {
  it("accepts a real zone", () => {
    expect(validTimeZone("Europe/London")).toBe(true);
    expect(validTimeZone("UTC")).toBe(true);
  });

  it("rejects a made-up zone", () => {
    expect(validTimeZone("Mars/Base")).toBe(false);
  });

  it("rejects an empty zone", () => {
    expect(validTimeZone("")).toBe(false);
  });
});
