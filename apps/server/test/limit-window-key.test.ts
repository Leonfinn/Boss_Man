import { describe, expect, it } from "vitest";
import { limitWindowKey } from "../src/services/limit-requeue.js";

// BOS-1767: pins the account-limit window wording a provider refusal names, as readings store it.
// Only limitWindowKey is pure in limit-requeue.ts; the rest needs a database.
describe("limitWindowKey", () => {
  it("maps a weekly window to the reading's seven_day", () => {
    expect(limitWindowKey("weekly")).toBe("seven_day");
    expect(limitWindowKey("the weekly limit")).toBe("seven_day");
    expect(limitWindowKey("weekly 5-hour")).toBe("seven_day");
  });

  it("maps a 5-hour window to five_hour, spelled with digits or words", () => {
    expect(limitWindowKey("5-hour")).toBe("five_hour");
    expect(limitWindowKey("five-hour")).toBe("five_hour");
    expect(limitWindowKey("the 5-hour limit")).toBe("five_hour");
    expect(limitWindowKey("the five-hour limit")).toBe("five_hour");
  });

  it("turns any other wording into underscores", () => {
    expect(limitWindowKey("daily")).toBe("daily");
    expect(limitWindowKey("the daily limit")).toBe("daily_limit");
    expect(limitWindowKey("monthly quota")).toBe("monthly_quota");
    expect(limitWindowKey("100% used")).toBe("100%_used");
  });

  it("collapses runs of whitespace, including tabs and newlines", () => {
    expect(limitWindowKey("multi   space")).toBe("multi_space");
    expect(limitWindowKey("a\tb\nc")).toBe("a_b_c");
    expect(limitWindowKey("  leading")).toBe("_leading");
    expect(limitWindowKey("trailing  ")).toBe("trailing_");
  });

  it("strips only one leading 'the ', and only when a space follows it", () => {
    expect(limitWindowKey("the the limit")).toBe("the_limit");
    expect(limitWindowKey("the limit")).toBe("limit");
    expect(limitWindowKey("the")).toBe("the");
    expect(limitWindowKey("theo limit")).toBe("theo_limit");
  });

  it("matches the weekly and 5-hour words only in lower case", () => {
    expect(limitWindowKey("Weekly")).toBe("Weekly");
    expect(limitWindowKey("5-Hour")).toBe("5-Hour");
    expect(limitWindowKey("WEEKLY")).toBe("WEEKLY");
  });

  it("returns an empty key for empty input", () => {
    expect(limitWindowKey("")).toBe("");
  });
});
