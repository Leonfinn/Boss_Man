// BOS-1522: scrub() is what keeps the SMTP password out of a send error before it is shown to the owner
// (BOS-1387). It removes three forms of every secret: as typed, its base64, and the base64 of a NUL byte
// followed by the secret (the AUTH PLAIN login form). These are made-up passwords only.
import { describe, expect, it } from "vitest";
import { scrub } from "../src/services/mailer.js";

const MASK = "•••";

describe("scrub removes a secret's plain form", () => {
  it("replaces a secret that appears once", () => {
    expect(scrub("535 Authentication failed for Zx9-secret", ["Zx9-secret"])).toBe(`535 Authentication failed for ${MASK}`);
  });

  it("replaces every occurrence of a secret", () => {
    expect(scrub("Zx9-secret ... Zx9-secret ... Zx9-secret", ["Zx9-secret"])).toBe(`${MASK} ... ${MASK} ... ${MASK}`);
  });
});

describe("scrub removes each encoded form on its own", () => {
  it("replaces the base64 form", () => {
    expect(scrub("base64: Wng5LXNlY3JldA==", ["Zx9-secret"])).toBe(`base64: ${MASK}`);
  });

  it("replaces the NUL-prefixed base64 (AUTH PLAIN) form", () => {
    expect(scrub("response: AFp4OS1zZWNyZXQ=", ["Zx9-secret"])).toBe(`response: ${MASK}`);
  });

  it("removes all three forms from the same text", () => {
    const text = ["Zx9-secret", "Wng5LXNlY3JldA==", "AFp4OS1zZWNyZXQ="].join(" ");
    expect(scrub(text, ["Zx9-secret"])).toBe([MASK, MASK, MASK].join(" "));
  });
});

describe("scrub handles several secrets and absent ones", () => {
  it("removes two secrets in one call, including their encoded forms", () => {
    const text = "Zx9-secret / aHVudGVyMi1wbGFpbg== / hunter2-plain / AGh1bnRlcjItcGxhaW4=";
    expect(scrub(text, ["Zx9-secret", "hunter2-plain"])).toBe([MASK, MASK, MASK, MASK].join(" / "));
  });

  it("leaves the text unchanged for null, undefined and an empty string in the list", () => {
    const text = "Connection refused, no secret here.";
    expect(scrub(text, [null, undefined, ""])).toBe(text);
  });

  it("leaves text with no secret in it unchanged", () => {
    const text = "535 Authentication failed";
    expect(scrub(text, ["Zx9-secret"])).toBe(text);
  });
});

describe("scrub's minimum length and literal matching", () => {
  it("leaves a 2-character secret's plain form alone but still replaces its longer encoded forms", () => {
    // The plain form "ab" is under 3 characters, so it stays; both base64 forms are longer and go.
    expect(scrub("ab ab YWI= AGFi", ["ab"])).toBe(`ab ab ${MASK} ${MASK}`);
  });

  it("replaces a secret full of regex characters literally", () => {
    // "a.b*c" as a regex would also match "aXbbc"; only the exact text must go, the rest must survive.
    expect(scrub("login a.b*c failed, not aXbbc", ["a.b*c"])).toBe(`login ${MASK} failed, not aXbbc`);
  });
});
