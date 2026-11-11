// BOS-1108: ATTACHMENT_LINK finds picture and file links again in the owner's own words (BOS-759).
// The pattern is not global, so testing one text cannot change the answer for the next.
import { describe, expect, it } from "vitest";
import { ATTACHMENT_LINK, fileMarkdown, imageMarkdown } from "../src/services/ticket-images.js";

const IMAGE_ID = "01234567-89ab-cdef-0123-456789abcdef";
const FILE_ID = "fedcba98-7654-3210-fedc-ba9876543210";

describe("ATTACHMENT_LINK", () => {
  it("matches the link imageMarkdown writes", () => {
    expect(ATTACHMENT_LINK.test(imageMarkdown("screenshot.png", IMAGE_ID))).toBe(true);
  });

  it("matches the link fileMarkdown writes", () => {
    expect(ATTACHMENT_LINK.test(fileMarkdown("report.pdf", FILE_ID))).toBe(true);
  });

  it("matches a link inside a longer sentence", () => {
    const text = `Here is the picture you asked for: ${imageMarkdown("shot.png", IMAGE_ID)} thanks!`;
    expect(ATTACHMENT_LINK.test(text)).toBe(true);
  });

  it("does not match a short id", () => {
    expect(ATTACHMENT_LINK.test(imageMarkdown("shot.png", "abc"))).toBe(false);
  });

  it("does not match a non-hex id", () => {
    expect(ATTACHMENT_LINK.test(imageMarkdown("shot.png", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"))).toBe(false);
  });

  it("does not match a link to another path", () => {
    expect(ATTACHMENT_LINK.test("[📎 report.pdf](/api/other-files/01234567-89ab-cdef-0123-456789abcdef)")).toBe(false);
  });

  it("gives the same answer when the same text is tested twice (not global)", () => {
    const text = imageMarkdown("shot.png", IMAGE_ID);
    expect(ATTACHMENT_LINK.test(text)).toBe(true);
    expect(ATTACHMENT_LINK.test(text)).toBe(true);
  });
});
