import { describe, expect, it } from "vitest";
import { urgentClaims } from "../src/mcp-common.js";

describe("urgentClaims: a reference within 40 characters of the word", () => {
  it("counts a reference before the word at the 40-character edge", () => {
    expect(urgentClaims(`BOS-12${" ".repeat(34)}urgent`)).toEqual({ numbers: [12], unnamed: false });
  });

  it("ignores a reference 41 characters before the word and leaves the word unnamed", () => {
    expect(urgentClaims(`BOS-12${" ".repeat(35)}urgent`)).toEqual({ numbers: [], unnamed: true });
  });

  it("counts a reference after the word at the 40-character edge", () => {
    expect(urgentClaims(`urgent${" ".repeat(34)}BOS-12`)).toEqual({ numbers: [12], unnamed: false });
  });

  it("ignores a reference 41 characters after the word and leaves the word unnamed", () => {
    expect(urgentClaims(`urgent${" ".repeat(35)}BOS-12`)).toEqual({ numbers: [], unnamed: true });
  });

  it("names both references near one word", () => {
    expect(urgentClaims("BOS-12 and BOS-7 are urgent")).toEqual({ numbers: [12, 7], unnamed: false });
  });

  it("lists the same reference once when it is claimed twice", () => {
    expect(urgentClaims("BOS-12 urgent; BOS-12 again urgent")).toEqual({ numbers: [12], unnamed: false });
  });
});

describe("urgentClaims: forms that are not claims", () => {
  it.each(["This is not urgent", "This is non-urgent", "This is non urgent", "This isn't urgent"])(
    "does not read %j as a claim",
    (body) => expect(urgentClaims(body)).toEqual({ numbers: [], unnamed: false }),
  );

  it("reports nothing when the word is absent", () => {
    expect(urgentClaims("BOS-12 can wait; nothing here needs a rush.")).toEqual({ numbers: [], unnamed: false });
  });
});

describe("urgentClaims: the word and the reference it names", () => {
  it("reads the word in capitals", () => {
    expect(urgentClaims("BOS-12 is URGENT")).toEqual({ numbers: [12], unnamed: false });
  });

  it("treats the word with no reference near it as unnamed", () => {
    expect(urgentClaims("This is urgent.")).toEqual({ numbers: [], unnamed: true });
  });

  it("takes the number from a reference with another prefix", () => {
    expect(urgentClaims("HOL-7 is urgent")).toEqual({ numbers: [7], unnamed: false });
  });
});
