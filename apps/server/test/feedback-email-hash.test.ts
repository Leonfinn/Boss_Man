// BOS-1707 (background lane): the one-address-one-hash rule behind the feedback portal's
// confirmed-address list. `emailHash` normalises an address before hashing it, so the same
// person typing "Owner@Example.com " and "owner@example.com" is remembered once. Pure: no
// database, network, clock or files. Route lane exhausted, so this follows BOS-1448/BOS-1687's
// fallback to a service file not taken by the services lane.
import { describe, expect, it } from "vitest";
import { emailHash } from "../src/services/feedback.js";

const OWNER = "c8cd3c6427301eaf6665bccacd65ddb614527acc843a15463e3faba57124c351";
const OTHER = "72497f475e4f76d0b28f57c73a084ece576d170874eba3ee2609d9afe4b71aab";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("emailHash", () => {
  it("is the SHA-256 of the trimmed, lowercased address", () => {
    expect(emailHash("owner@example.com")).toBe(OWNER);
  });

  it("gives the same hash however the address was typed: case and surrounding spaces", () => {
    expect(emailHash(" Owner@Example.com ")).toBe(OWNER);
    expect(emailHash("OWNER@EXAMPLE.COM")).toBe(OWNER);
    expect(emailHash("owner@example.com\t")).toBe(OWNER);
    expect(emailHash("\nowner@example.com  ")).toBe(OWNER);
    expect(emailHash("owner@example.com")).toBe(emailHash("Owner@Example.COM"));
  });

  it("keeps different addresses apart", () => {
    expect(emailHash("someone@example.com")).toBe(OTHER);
    expect(emailHash("someone@example.com")).not.toBe(OWNER);
  });

  it("trims the whole address, so blank and empty input hash the empty string", () => {
    expect(emailHash("")).toBe(EMPTY);
    expect(emailHash("   ")).toBe(EMPTY);
    expect(emailHash("\t\n")).toBe(EMPTY);
  });

  it("always returns 64 lowercase hex characters", () => {
    for (const address of ["owner@example.com", "A@B.test", "", "  spaced@example.com "]) {
      expect(emailHash(address)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is deterministic", () => {
    expect(emailHash("owner@example.com")).toBe(emailHash("owner@example.com"));
  });
});
