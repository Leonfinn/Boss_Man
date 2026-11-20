// shortSlug and otherCompany decide whether a wiki link carrying a company id opens here or is
// another company's page. Both are pure, so each case is a plain input and answer.
import { describe, expect, it } from "vitest";
import { otherCompany, shortSlug } from "../src/links";

const U1 = "8c7f803d-8266-4cae-b17b-79e289142018";
const U2 = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";

describe("shortSlug", () => {
  it("drops the company id prefix", () => {
    expect(shortSlug("abc/page", "abc")).toBe("page");
  });
  it("leaves a page with no prefix alone", () => {
    expect(shortSlug("page", "abc")).toBe("page");
  });
  it("leaves the slug alone without a company", () => {
    expect(shortSlug("abc/page", undefined)).toBe("abc/page");
  });
  it("needs the prefix to end in a slash", () => {
    expect(shortSlug("abcdef/page", "abc")).toBe("abcdef/page");
  });
  it("gives an empty name when nothing follows the slash", () => {
    expect(shortSlug("abc/", "abc")).toBe("");
  });
});

describe("otherCompany", () => {
  it("is true for another company's id prefix", () => {
    expect(otherCompany(`${U2}/page`, U1)).toBe(true);
  });
  it("is false for this company's id prefix", () => {
    expect(otherCompany(`${U1}/page`, U1)).toBe(false);
  });
  it("is false for a page with no prefix", () => {
    expect(otherCompany("page", U1)).toBe(false);
  });
  it("is true for an id prefix when no company is known", () => {
    expect(otherCompany(`${U2}/page`)).toBe(true);
  });
  it("is false for an uppercase id prefix (only lowercase ids match)", () => {
    expect(otherCompany(`${U2.toUpperCase()}/page`, U1)).toBe(false);
  });
  it("is false for a bare id with no slash", () => {
    expect(otherCompany(U2, U1)).toBe(false);
  });
});
