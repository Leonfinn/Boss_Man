// A PNG tEXt chunk that says how a screenshot was made (BOS-2511, DR-075). scripts/screenshot.mjs writes
// `bossman-screenshot` = `api=seeded` when it serves the build with --api fixtures, and the server's move-to-review
// check counts only pictures that carry it, so a browser shot of an HTML mock-up doesn't pass as the app.
// It is not a signature: it stops the accidental path, not deliberate forgery.
import { crc32 } from "node:zlib";

export const SCREENSHOT_MARKER_KEY = "bossman-screenshot";
export const SCREENSHOT_MARKER_SEEDED = "api=seeded";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The PNG with a tEXt chunk `key`=`value` put right after IHDR (so a reader finds it in the first bytes). */
export function addPngText(png, key, value) {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR") throw new Error("not a PNG");
  const afterIhdr = 8 + 12 + png.readUInt32BE(8);
  const data = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")]);
  const typeAndData = Buffer.concat([Buffer.from("tEXt", "latin1"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([png.subarray(0, afterIhdr), len, typeAndData, crc, png.subarray(afterIhdr)]);
}
