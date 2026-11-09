import { describe, expect, it } from "vitest";
import { ageLabel, raisedAgo } from "../src/age";

describe("card age (BOS-869)", () => {
  it("says the same words the Decisions and Plan pages show", () => {
    expect(ageLabel(30_000)).toBe("just now");
    expect(ageLabel(8 * 60_000)).toBe("8 min ago");
    expect(ageLabel(3 * 3_600_000)).toBe("3h ago");
    expect(ageLabel(5 * 86_400_000)).toBe("5d ago");
  });

  it("treats a timestamp in the future as just now, not a negative age", () => {
    expect(ageLabel(-5_000)).toBe("just now");
  });

  it("reads an ISO time to the same label", () => {
    const now = new Date("2026-11-09T12:00:00Z").getTime();
    expect(raisedAgo("2026-11-09T11:52:00Z", now)).toBe("8 min ago");
  });
});
