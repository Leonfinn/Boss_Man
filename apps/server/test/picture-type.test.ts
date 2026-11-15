// BOS-1352: an imported agent picture is typed from its first bytes, never its name.
import { describe, expect, it } from "vitest";
import { pictureType } from "../src/services/company-import.js";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const WAVE = [0x57, 0x41, 0x56, 0x45];
const SIZE = [0x24, 0x00, 0x00, 0x00];

describe("pictureType", () => {
  describe("PNG", () => {
    it("names the 8-byte signature image/png", () => {
      expect(pictureType(new Uint8Array([...PNG_SIG, 0x00, 0x00, 0x00, 0x0d]))).toBe("image/png");
    });

    it("refuses the signature when its last byte is changed", () => {
      expect(pictureType(new Uint8Array([...PNG_SIG.slice(0, 7), 0x0b]))).toBeNull();
    });
  });

  describe("JPEG", () => {
    it("names FF D8 FF with anything after it image/jpeg", () => {
      expect(pictureType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("image/jpeg");
    });

    it("refuses FF D8 00", () => {
      expect(pictureType(new Uint8Array([0xff, 0xd8, 0x00, 0xe0]))).toBeNull();
    });
  });

  describe("WebP", () => {
    it("names RIFF, a size and WEBP image/webp", () => {
      expect(pictureType(new Uint8Array([...RIFF, ...SIZE, ...WEBP]))).toBe("image/webp");
    });

    it("refuses a WAVE sound file that starts with RIFF", () => {
      expect(pictureType(new Uint8Array([...RIFF, ...SIZE, ...WAVE]))).toBeNull();
    });

    it("refuses a lower-case riff", () => {
      expect(pictureType(new Uint8Array([0x72, 0x69, 0x66, 0x66, ...SIZE, ...WEBP]))).toBeNull();
    });
  });

  describe("anything else", () => {
    it("refuses an empty array", () => {
      expect(pictureType(new Uint8Array([]))).toBeNull();
    });

    it("refuses a 2-byte array", () => {
      expect(pictureType(new Uint8Array([0x89, 0x50]))).toBeNull();
    });

    it("refuses a GIF", () => {
      expect(pictureType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
    });

    it("refuses plain text that starts like an SVG", () => {
      expect(pictureType(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull();
    });

    it("refuses a PDF", () => {
      expect(pictureType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
    });
  });
});
