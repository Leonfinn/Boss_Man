// BOS-764 (QA, BOS-826): "does the live runner image already have this change?" The answer decides whether the owner is asked to
// click Build and update runners, so every doubt must answer no (ask as before), and only a placed, older-or-equal merge answers yes.
import { describe, expect, it } from "vitest";
import { imageContains } from "../src/services/runner-image.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const X = "9".repeat(40);
const order = [A, B, C]; // oldest merge first

describe("imageContains (BOS-764)", () => {
  it("is true for the commit the image was built from", () => {
    expect(imageContains(C, C, order)).toBe(true);
    expect(imageContains(X, X, order)).toBe(true); // even one that isn't in merge order
  });

  it("is true for a merge placed before or at the image's merge", () => {
    expect(imageContains(C, A, order)).toBe(true);
    expect(imageContains(B, B, order)).toBe(true);
  });

  it("is false for a merge placed after the image's merge", () => {
    expect(imageContains(A, B, order)).toBe(false);
    expect(imageContains(B, C, order)).toBe(false);
  });

  it("is false when the image commit is not recorded (an image built before BOS-764)", () => {
    expect(imageContains(null, A, order)).toBe(false);
  });

  it("is false when there is no commit to look for", () => {
    expect(imageContains(C, null, order)).toBe(false);
    expect(imageContains(C, undefined, order)).toBe(false);
    expect(imageContains(C, "", order)).toBe(false);
  });

  it("is false when either commit can't be placed in merge order", () => {
    expect(imageContains(X, A, order)).toBe(false); // image built from a commit that never merged through the gate
    expect(imageContains(C, X, order)).toBe(false); // a change Boss Man can't place is never assumed to be inside
    expect(imageContains(C, A, [])).toBe(false);
  });

  it("compares commits without regard to case", () => {
    expect(imageContains(C, A.toUpperCase(), order)).toBe(true);
    expect(imageContains(C, C.toUpperCase(), order)).toBe(true);
  });
});
