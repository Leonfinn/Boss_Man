// A picture copied onto an agent from a ticket image is capped at 256 KB (BOS-320): it travels inside
// every run start. Rather than refuse a photo that's over the cap, the server shrinks it first, so the
// owner can use any screenshot or photo from a ticket. The codecs are pure WebAssembly, so the runner
// image needs no new native libraries. Their Node.js entry points are written for a browser (they
// fetch the .wasm over HTTP), so here each one is handed its compiled module directly.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initPng, { decode as decodePng } from "@jsquash/png/codec/pkg/squoosh_png.js";
import encodePng from "@jsquash/png/encode.js";
import decodeJpeg, { init as initJpegDec } from "@jsquash/jpeg/decode.js";
import encodeJpeg, { init as initJpegEnc } from "@jsquash/jpeg/encode.js";
import decodeWebp, { init as initWebpDec } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEnc } from "@jsquash/webp/encode.js";
import initResize, { resize as resizePixels } from "@jsquash/resize/lib/resize/pkg/squoosh_resize.js";
import { pictureType } from "./company-import.js";

/** The size a picture is scaled down to when it doesn't fit; the owner's uploads use the same cap. */
export const PICTURE_MAX_BYTES = 256 * 1024;
/** The longest side, in pixels, a shrunk picture keeps. Avatars and the board never show more. */
export const PICTURE_MAX_SIDE = 512;

type Size = { width: number; height: number };
type Shrunk = { bytes: Buffer; type: string };
type Pixels = { data: Uint8ClampedArray; width: number; height: number };
type Encode = (data: Pixels, options?: { quality?: number }) => Promise<ArrayBuffer>;

const require_ = createRequire(import.meta.url);
const module_ = (path: string) => new WebAssembly.Module(readFileSync(require_.resolve(path)));

/** The codecs' decode and encode once their WebAssembly modules are loaded; null until then. */
type Decode = (data: ArrayBuffer) => Promise<Pixels>;
type Codecs = { decode: Record<string, Decode>; encode: Record<string, Encode> };

let loading: Promise<Codecs> | undefined;

/** Loads every codec once, so the first oversized picture pays the cost and later ones don't. */
function codecs(): Promise<Codecs> {
  return (loading ??= (async () => {
    await initPng(module_(PNG_WASM));
    await initResize(module_(RESIZE_WASM));
    await initJpegDec(module_(JPEG_DEC_WASM));
    await initJpegEnc(module_(JPEG_ENC_WASM));
    await initWebpDec(module_(WEBP_DEC_WASM));
    await initWebpEnc(module_(WEBP_ENC_WASM));
    return {
      decode: {
        "image/png": async (d) => decodePng(new Uint8Array(d)),
        "image/jpeg": decodeJpeg as Decode,
        "image/webp": decodeWebp as Decode,
      },
      encode: {
        "image/png": (d) => encodePng(d as ImageData),
        "image/jpeg": (d, o) => encodeJpeg(d as ImageData, o),
        "image/webp": (d, o) => encodeWebp(d as ImageData, o),
      },
    };
  })());
}

const PNG_WASM = "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
const RESIZE_WASM = "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm";
const JPEG_DEC_WASM = "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
const JPEG_ENC_WASM = "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm";
const WEBP_DEC_WASM = "@jsquash/webp/codec/dec/webp_dec.wasm";
const WEBP_ENC_WASM = "@jsquash/webp/codec/enc/webp_enc.wasm";

/** Loads the codecs ahead of time, so a caller that builds its own test pictures can use the same ones. */
export const loadPictures = () => codecs();

/** The picture's width and height from its header, without decoding the pixels; null if it's damaged. */
export function pictureSize(bytes: Uint8Array, type: string): Size | null {
  const b = Buffer.from(bytes);
  try {
    if (type === "image/png") {
      if (b.length < 24 || b.toString("latin1", 12, 16) !== "IHDR") return null;
      const width = b.readUInt32BE(16);
      const height = b.readUInt32BE(20);
      return width && height ? { width, height } : null;
    }
    if (type === "image/jpeg") {
      for (let i = 2; i + 9 < b.length; ) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        const len = b.readUInt16BE(i + 2);
        // Every start-of-frame marker carries the size; the rest just step over their segment.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = b.readUInt16BE(i + 5);
          const width = b.readUInt16BE(i + 7);
          return width && height ? { width, height } : null;
        }
        i += 2 + len;
      }
      return null;
    }
    if (type === "image/webp") {
      if (b.length < 30) return null;
      const chunk = b.toString("latin1", 12, 16);
      if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

const buffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** The pixels, scaled; the kernel (method 3 is lanczos3) takes raw RGBA and hands back RGBA. */
function scale(pixels: Pixels, width: number, height: number): Pixels {
  const out = resizePixels(new Uint8Array(pixels.data), pixels.width, pixels.height, width, height, 3, true, false);
  return { data: new Uint8ClampedArray(out.buffer, out.byteOffset, out.byteLength), width, height };
}

/**
 * A picture under the cap that an agent can use as its avatar (BOS-320). A picture that already fits
 * comes back untouched; a larger one is decoded, scaled to fit 512 px on its longest side and written
 * back in the same format, losing quality step by step only until it's under the cap. Null means it
 * can't be shrunk: damaged bytes, an image already within 512 px (whose size is its detail), or one
 * still too large at the lowest quality — the caller refuses those as before.
 */
export async function shrinkPicture(bytes: Uint8Array, maxBytes = PICTURE_MAX_BYTES): Promise<Shrunk | null> {
  const type = pictureType(bytes);
  if (!type) return null;
  if (bytes.length <= maxBytes) return { bytes: Buffer.from(bytes), type };
  const size = pictureSize(bytes, type);
  if (!size || (size.width <= PICTURE_MAX_SIDE && size.height <= PICTURE_MAX_SIDE)) return null;
  let pixels: Pixels;
  let c: Codecs;
  try {
    c = await codecs();
    pixels = await c.decode[type]!(buffer(bytes));
  } catch {
    return null;
  }
  if (!pixels.width || !pixels.height) return null;
  const ratio = Math.min(1, PICTURE_MAX_SIDE / Math.max(pixels.width, pixels.height));
  if (ratio < 1) pixels = scale(pixels, Math.max(1, Math.round(pixels.width * ratio)), Math.max(1, Math.round(pixels.height * ratio)));
  // PNG is lossless, so only a smaller size helps it; the other formats lose quality until they fit.
  const qualities = type === "image/png" ? [0] : [80, 65, 50, 35, 20];
  for (const quality of qualities) {
    try {
      const out = await c.encode[type]!(pixels, { quality });
      if (out.byteLength <= maxBytes) return { bytes: Buffer.from(out), type };
    } catch {
      return null;
    }
  }
  return null;
}
