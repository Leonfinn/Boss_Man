import { describe, expect, it } from "vitest";
import { ageWords } from "../src/age.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

describe("ageWords: one way to say how long ago something was (BOS-887)", () => {
  it("counts minutes under two hours, with a singular at one", () => {
    expect(ageWords(59_000)).toBe("1 minute");
    expect(ageWords(0)).toBe("1 minute");
    expect(ageWords(MIN)).toBe("1 minute");
    expect(ageWords(2 * MIN)).toBe("2 minutes");
    expect(ageWords(59 * MIN + 59_000)).toBe("59 minutes");
    expect(ageWords(61 * MIN)).toBe("61 minutes");
    expect(ageWords(90 * MIN)).toBe("90 minutes");
    expect(ageWords(119 * MIN)).toBe("119 minutes");
  });

  it("never says \"1 hours\": an hour is hours only from two, floored", () => {
    expect(ageWords(2 * H)).toBe("2 hours");
    expect(ageWords(2 * H + 59 * MIN)).toBe("2 hours");
    expect(ageWords(23 * H)).toBe("23 hours");
  });

  it("counts days from two days, with a singular at one, floored", () => {
    expect(ageWords(47 * H)).toBe("47 hours");
    expect(ageWords(2 * D)).toBe("2 days");
    expect(ageWords(2 * D + 23 * H)).toBe("2 days");
    expect(ageWords(9 * D)).toBe("9 days");
  });

  it("treats a clock slightly ahead of now as a minute, never 0 or negative", () => {
    expect(ageWords(-5_000)).toBe("1 minute");
  });

  it("has a short form for the notes that want it, with the same cut-offs", () => {
    expect(ageWords(1 * MIN, { short: true })).toBe("1 min");
    expect(ageWords(90 * MIN, { short: true })).toBe("90 min");
    expect(ageWords(2 * H, { short: true })).toBe("2 h");
    expect(ageWords(2 * D, { short: true })).toBe("2 days");
  });
});
