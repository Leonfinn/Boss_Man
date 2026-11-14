// Direct tests for the owner password hash: the shape it stores, a fresh salt per hash, and
// that verifyPassword answers true only for the password that was hashed (BOS-1232).
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth.js";

const PASSWORD = "correct horse battery";
const UNICODE_PASSWORD = "pässwörd🔑";

let hash: string;
let secondHash: string;
let unicodeHash: string;
let emptyHash: string;

beforeAll(async () => {
  // Four hashes, well under the ~15 the ticket allows: scrypt is deliberately ~100 ms each.
  hash = await hashPassword(PASSWORD);
  secondHash = await hashPassword(PASSWORD);
  unicodeHash = await hashPassword(UNICODE_PASSWORD);
  emptyHash = await hashPassword("");
});

describe("hashPassword", () => {
  it("stores six $ parts with the scrypt parameters first", () => {
    const parts = hash.split("$");
    expect(parts).toHaveLength(6);
    expect(hash.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(parts[4]).not.toBe("");
    expect(parts[5]).not.toBe("");
  });

  it("makes a fresh salt each time, and both hashes verify", async () => {
    expect(secondHash).not.toBe(hash);
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, secondHash)).resolves.toBe(true);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password", async () => {
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
  });

  it("refuses a wrong password", async () => {
    await expect(verifyPassword("wrong password here", hash)).resolves.toBe(false);
    await expect(verifyPassword("", hash)).resolves.toBe(false);
  });

  it("refuses different capitals and a trailing space", async () => {
    await expect(verifyPassword(PASSWORD.toUpperCase(), hash)).resolves.toBe(false);
    await expect(verifyPassword(`${PASSWORD} `, hash)).resolves.toBe(false);
  });

  it("accepts an empty password when that is what was hashed", async () => {
    await expect(verifyPassword("", emptyHash)).resolves.toBe(true);
    await expect(verifyPassword(" ", emptyHash)).resolves.toBe(false);
  });

  it("treats non-ASCII passwords the same way", async () => {
    await expect(verifyPassword(UNICODE_PASSWORD, unicodeHash)).resolves.toBe(true);
    await expect(verifyPassword("passwörd🔑", unicodeHash)).resolves.toBe(false);
    await expect(verifyPassword("PÄSSWÖRD🔑", unicodeHash)).resolves.toBe(false);
  });

  it("returns false, without throwing, for damaged stored hashes", async () => {
    const parts = hash.split("$");
    const missingLastPart = parts.slice(0, -1).join("$");
    const hashPart = parts[5]!;
    const alteredLastPart = [...parts.slice(0, -1), (hashPart[0] === "A" ? "B" : "A") + hashPart.slice(1)].join("$");

    for (const stored of [
      "",
      "bcrypt$32768$8$1$c2FsdA==$aGFzaA==",
      missingLastPart,
      alteredLastPart,
    ]) {
      await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(false);
    }
  });
});
