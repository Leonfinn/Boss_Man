// Fits an oversized agent picture under the size cap instead of refusing it (BOS-320).
//
// The codecs are the Squoosh ones compiled to WebAssembly (jSquash), so the server needs no native
// binary and the runtime image stays node:bookworm-slim: the wasm programs ship in the packages and
// are compiled once, here, on first use. Decoding, resizing and encoding all happen in-process.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import resize, { initResize } from "@jsquash/resize";
import pngDecode, { init as pngInit } from "@jsquash/png/decode.js";
import pngEncode, { init as pngEncodeInit } from "@jsquash/png/encode.js";
import jpegDecode, { init as jpegInit } from "@jsquash/jpeg/decode.js";
import jpegEncode, { init as jpegEncodeInit } from "@jsquash/jpeg/encode.js";
import webpDecode, { init as webpInit } from "@jsquash/webp/decode.js";
import webpEncode, { init as webpEncodeInit } from "@jsquash/webp/encode.js";
import { pictureType } from "./company-import.js";

/** What the codecs decode to and encode from: RGBA pixels, the browser's ImageData shape. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** The longest side of a shrunk picture. Pictures are shown at roughly 128-256 px, so 512 covers retina. */
export const SHRUNK_MAX_EDGE = 512;

const require = createRequire(import.meta.url);

/** A .wasm file shipped with one of the codec packages, compiled so the codec uses it instead of fetching it. */
async function wasm(spec: string): Promise<WebAssembly.Module> {
  return new WebAssembly.Module(await readFile(require.resolve(spec)));
}

export type PictureType = "image/png" | "image/jpeg" | "image/webp";

/** The codecs take an ArrayBuffer, and only a plain one: a view into a pooled Buffer can be a SharedArrayBuffer. */
const arrayBuffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * The most pixels a picture may have before it is decoded. Decoding happens in-process, so a
 * picture claiming a vast canvas (a decompression bomb, say) is refused before it fills memory.
 * 40 megapixels is far above any picture meant as an avatar, so a real one never hits it.
 */
export const MAX_DECODE_PIXELS = 40_000_000;

/** The size the picture's header claims, so an oversized canvas is turned away before decoding. */
export function claimedSize(bytes: Uint8Array): { width: number; height: number } | null {
  const type = pictureType(bytes);
  // PNG: the 8-byte signature, then IHDR, whose first 8 bytes are the width and height, big-endian.
  if (type === "image/png" && bytes.length >= 24) {
    const view = new DataView(arrayBuffer(bytes.subarray(16, 24)));
    return { width: view.getUint32(0), height: view.getUint32(4) };
  }
  // JPEG: walk the markers to the start-of-frame, which holds the height then the width.
  if (type === "image/jpeg") {
    for (let i = 2; i + 9 < bytes.length; i += 2 + ((bytes[i + 2]! << 8) | bytes[i + 3]!)) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: (bytes[i + 7]! << 8) | bytes[i + 8]!, height: (bytes[i + 5]! << 8) | bytes[i + 6]! };
    }
  }
  if (type === "image/webp" && bytes.length >= 20) return webpClaimedSize(bytes);
  return null;
}

/**
 * A WebP's canvas, read from its first chunk (bytes 12-15 name it): "VP8X" an extended file, "VP8L" a
 * lossless one, "VP8 " a simple lossy one. Each stores the width and height in a different place. A
 * WebP the format doesn't recognise is refused rather than decoded blind.
 */
function webpClaimedSize(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = Buffer.from(bytes.subarray(12, 16)).toString("latin1");
  const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
  if (chunk === "VP8X" && bytes.length >= 30) return { width: u24(24) + 1, height: u24(27) + 1 };
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && bytes.length >= 30) return { width: (((bytes[27]! << 8) | bytes[26]!) & 0x3fff), height: (((bytes[29]! << 8) | bytes[28]!) & 0x3fff) };
  return null;
}

const decodeFor: Record<PictureType, (b: ArrayBuffer) => Promise<Pixels>> = { "image/png": pngDecode, "image/jpeg": jpegDecode, "image/webp": webpDecode };

let ready: Promise<void> | undefined;
/** Loads every wasm program once; concurrent calls share the one promise. */
function init(): Promise<void> {
  ready ??= (async () => {
    const png = await wasm("@jsquash/png/codec/pkg/squoosh_png_bg.wasm");
    await pngInit(png);
    await pngEncodeInit(png);
    await jpegInit(await wasm("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"));
    await jpegEncodeInit(await wasm("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"));
    await webpInit(await wasm("@jsquash/webp/codec/dec/webp_dec.wasm"));
    await webpEncodeInit(await wasm("@jsquash/webp/codec/enc/webp_enc_simd.wasm"));
    await initResize(await wasm("@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm"));
  })().catch((err: unknown) => {
    // Let the next attempt try again rather than leave every later call on a rejected promise.
    ready = undefined;
    throw err;
  });
  return ready;
}

/** Encodes in the picture's own format, since the stored type has to keep matching the bytes. */
async function encode(type: PictureType, image: Pixels, quality: number): Promise<Buffer> {
  const bytes =
    type === "image/png" ? await pngEncode(image as Parameters<typeof pngEncode>[0])
    : type === "image/jpeg" ? await jpegEncode(image as Parameters<typeof jpegEncode>[0], { quality })
    : await webpEncode(image as Parameters<typeof webpEncode>[0], { quality });
  return Buffer.from(bytes);
}

const scaled = (image: Pixels, width: number, height: number) => resize(image as Parameters<typeof resize>[0], { width, height, fitMethod: "stretch" }) as Promise<Pixels>;

/**
 * Reduces an image to fit `maxBytes`, keeping its format. Tries gentle first: at full quality, then
 * lighter settings (for JPEG and WebP), then smaller and smaller pictures. Returns null when the
 * bytes aren't an image this can decode (a corrupt file, say), whose header can't be read, or that
 * claims more pixels than MAX_DECODE_PIXELS, so the caller can say so plainly.
 */
export async function shrinkPicture(bytes: Uint8Array, type: PictureType, maxBytes: number): Promise<Buffer | null> {
  if (bytes.length <= maxBytes) return Buffer.from(bytes);
  // Every format here has a readable header; one that doesn't is refused, since decoding it blind
  // could still take unbounded memory.
  const claimed = claimedSize(bytes);
  if (!claimed || claimed.width * claimed.height > MAX_DECODE_PIXELS) return null;
  await init();
  let image: Pixels;
  try {
    image = await decodeFor[type](arrayBuffer(bytes));
  } catch {
    return null;
  }
  const edge = Math.max(image.width, image.height);
  if (!edge || !image.data.length) return null;
  // PNG is lossless, so the quality setting does nothing; one pass at each size says as much as three.
  const qualities = type === "image/png" ? [90] : [90, 75, 60];
  // Longest side at most SHRUNK_MAX_EDGE, and never upscaled; each attempt that misses the cap shrinks further.
  let scale = Math.min(1, SHRUNK_MAX_EDGE / edge);
  for (let attempt = 0; attempt < 6; attempt++) {
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const small = width === image.width && height === image.height ? image : await scaled(image, width, height);
    for (const quality of qualities) {
      const out = await encode(type, small, quality);
      if (out.length <= maxBytes) return out;
    }
    scale *= 0.7;
  }
  // Nothing at these sizes fits: the caller refuses it rather than store something broken.
  return null;
}
