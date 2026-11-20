import { describe, expect, it } from "vitest";
import { dayLabel } from "../src/age";

describe("dayLabel", () => {
  it("keeps the calendar day whatever the time zone", () => {
    expect(dayLabel("2026-12-01", "en-GB")).toBe("1 Dec");
    expect(dayLabel("2026-01-01", "en-GB")).toBe("1 Jan");
    expect(dayLabel("2026-12-01T00:00:00.000Z", "en-GB")).toBe("1 Dec");
  });
  it("returns an unreadable value unchanged", () => {
    expect(dayLabel("soon")).toBe("soon");
  });
});
