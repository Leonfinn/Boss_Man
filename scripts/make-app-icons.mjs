// Builds the installable web app's icons from the owner's 512 px mark (assets/brand/boss-mark-512.png):
// boss-mark-192.png for "any" surfaces, and 192/512 "-maskable" copies with the mark shrunk into the
// safe circle and put on the sidebar navy, so Android's mask never clips his head. Vite copies
// apps/web/public into the build, so they are served from /app-icons/.
// Run: node scripts/make-app-icons.mjs
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

// The repository root, so the mark comes from the shared brand folder and the icons land in the web app.
const root = fileURLToPath(new URL("..", import.meta.url));
const brand = `${root}assets/brand/`;
const here = `${root}apps/web/public/app-icons/`;
const NAVY = [0x17, 0x20, 0x2c];
// Android's maskable safe zone: a circle of radius 40% of the icon, so the art fits inside 80%.
const SAFE = 0.8;

/** Minimal PNG reader/writer for 8-bit RGBA, non-interlaced, as the brand files are. */
function readPng(file) {
  const d = readFileSync(file);
  let p = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (p < d.length) {
    const len = d.readUInt32BE(p);
    const type = d.toString("ascii", p + 4, p + 8);
    const data = d.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error(`${file}: only 8-bit RGBA non-interlaced PNGs are read`);
    }
    if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= 4 ? out[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8);
  return c ^ -1;
}

function writePng(file, { w, h, data }) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  // Opaque icons are stored as RGB: the alpha channel would be mostly zeros, which deflates badly.
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  const rows = opaque ? rgbOf(data, w) : raw;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

/** The raw scans with the alpha channel dropped, for the RGB form. */
function rgbOf(rgba, w) {
  const out = Buffer.alloc((w * 3 + 1) * w);
  let o = 0;
  for (let y = 0; y < w; y++) {
    o++;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[o++] = rgba[i];
      out[o++] = rgba[i + 1];
      out[o++] = rgba[i + 2];
    }
  }
  return out;
}

/** Box-filter downscale (average of the source pixels each target pixel covers). */
function resize(src, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = src.w / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      const y0 = Math.floor(y * scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.w + sx) * 4;
          const alpha = src.data[i + 3] / 255;
          r += src.data[i] * alpha;
          g += src.data[i + 1] * alpha;
          b += src.data[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * size + x) * 4;
      const alpha = a / n;
      // Weighted by alpha, then un-multiplied, so the edges don't pick up the transparent corners.
      out[o] = alpha ? Math.round(r / a) : 0;
      out[o + 1] = alpha ? Math.round(g / a) : 0;
      out[o + 2] = alpha ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

/** The mark on the navy, fitted inside the maskable safe circle. */
function maskable(src, size) {
  const inner = Math.round(size * SAFE);
  const art = resize(src, inner);
  const off = Math.floor((size - inner) / 2);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      out[o] = NAVY[0];
      out[o + 1] = NAVY[1];
      out[o + 2] = NAVY[2];
      out[o + 3] = 255;
    }
  }
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const i = (y * inner + x) * 4;
      const alpha = art[i + 3] / 255;
      if (!alpha) continue;
      const o = ((y + off) * size + x + off) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = Math.round(art[i + k] * alpha + out[o + k] * (1 - alpha));
    }
  }
  return out;
}

const source = readPng(`${brand}boss-mark-512.png`);
writePng(`${here}boss-mark-192.png`, { w: 192, h: 192, data: resize(source, 192) });
for (const size of [192, 512]) writePng(`${here}boss-mark-${size}-maskable.png`, { w: size, h: size, data: maskable(source, size) });
// The 512 "any" icon is the owner's mark exactly as it is; a copy here keeps all the app's icons together.
copyFileSync(`${brand}boss-mark-512.png`, `${here}boss-mark-512.png`);
