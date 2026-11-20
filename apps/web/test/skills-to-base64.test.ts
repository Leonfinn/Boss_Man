// @vitest-environment jsdom
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/pages/Skills";

// BOS-1985: pin the byte-to-base64 helper behind skill uploads and the company import
// (Settings → Transfer). Node's Buffer is the reference encoder, so the pins hold in any runtime.

const reference = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("toBase64", () => {
  it("empty bytes encode to an empty string", () => {
    expect(toBase64(new Uint8Array())).toBe("");
    expect(toBase64(new Uint8Array())).toBe(reference(new Uint8Array()));
  });

  it("a short ASCII string matches Buffer", () => {
    const bytes = new TextEncoder().encode("hello, world");
    expect(toBase64(bytes)).toBe(reference(bytes));
    expect(toBase64(bytes)).toBe("aGVsbG8sIHdvcmxk");
  });

  it("every byte value 0–255 survives the round trip", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toBase64(bytes)).toBe(reference(bytes));
  });

  it("bytes longer than one 0x8000 chunk match Buffer across the boundary", () => {
    const bytes = Uint8Array.from({ length: 0x8000 + 7 }, (_, i) => (i * 31 + 7) % 256);
    expect(bytes.length).toBeGreaterThan(0x8000);
    expect(toBase64(bytes)).toBe(reference(bytes));
  });
});
