import { describe, expect, it } from "vitest";
import { ageLabel, ageShort, raisedAgo } from "../src/age";

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

describe("short age for card footers (BOS-888)", () => {
  it("gives the same number as the long words, only shorter", () => {
    expect(ageShort(30_000)).toBe("now");
    expect(ageShort(8 * 60_000)).toBe("8m");
    expect(ageShort(3 * 3_600_000)).toBe("3h");
    expect(ageShort(5 * 86_400_000)).toBe("5d");
  });

  it("treats a timestamp in the future as now, not a negative age", () => {
    expect(ageShort(-5_000)).toBe("now");
  });

  it("floors like ageLabel, so a Board footer and a Decisions card about the same run agree", () => {
    // 59 min 40 s is 59 minutes in both: the old Board rounded it up to "1h".
    for (const ms of [59_000, 90_000, (59 * 60 + 40) * 1_000, 3 * 3_600_000, 2 * 86_400_000]) {
      const unit = (s: string) => /\d+/.exec(s)?.[0] ?? "now";
      expect(unit(ageShort(ms)), `${ms} ms`).toBe(unit(ageLabel(ms)));
    }
  });
});
