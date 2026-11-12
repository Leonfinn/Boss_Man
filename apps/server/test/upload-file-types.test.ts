// BOS-1102: uploads are typed from their first bytes, never their name.
// logoType() names logos for the public portal (SVG must be refused); fileType() names ticket attachments.
import { describe, expect, it } from "vitest";
import { logoType } from "../src/services/image-type.js";
import { fileType } from "../src/services/ticket-images.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBP", "latin1")]);
const WAVE = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WAVE", "latin1")]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

describe("logoType", () => {
  it("names a PNG by its header", () => {
    expect(logoType(PNG)).toBe("image/png");
  });

  it("names a JPEG by its header", () => {
    expect(logoType(JPEG)).toBe("image/jpeg");
  });

  it("names a WebP by its header", () => {
    expect(logoType(WEBP)).toBe("image/webp");
  });

  it("refuses an SVG, because the portal is public", () => {
    expect(logoType(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`, "utf8"))).toBeNull();
  });

  it("refuses a GIF", () => {
    expect(logoType(Buffer.from("GIF89a", "latin1"))).toBeNull();
  });

  it("refuses a PDF", () => {
    expect(logoType(Buffer.from("%PDF-1.7", "latin1"))).toBeNull();
  });

  it("refuses a WAVE file even though it starts with RIFF", () => {
    expect(logoType(WAVE)).toBeNull();
  });

  it("refuses an empty buffer", () => {
    expect(logoType(Buffer.alloc(0))).toBeNull();
  });
});

describe("fileType", () => {
  it("names a PNG as image/png", () => {
    expect(fileType(PNG)).toBe("image/png");
  });

  it("names a PDF as application/pdf", () => {
    expect(fileType(Buffer.from("%PDF-1.7", "latin1"))).toBe("application/pdf");
  });

  it("names a zip as application/zip", () => {
    expect(fileType(ZIP)).toBe("application/zip");
  });

  it("names UTF-8 text, including multi-byte letters, as text/plain", () => {
    expect(fileType(Buffer.from("Grüße aus Köln — café ☕\n", "utf8"))).toBe("text/plain");
  });

  it("names a buffer with a NUL byte as application/octet-stream", () => {
    expect(fileType(Buffer.from("hello\0world", "utf8"))).toBe("application/octet-stream");
  });

  it("names invalid UTF-8 as application/octet-stream", () => {
    expect(fileType(Buffer.from([0xc3, 0x28, 0x41, 0x42]))).toBe("application/octet-stream");
  });
});
