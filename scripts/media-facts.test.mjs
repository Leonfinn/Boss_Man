import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatFacts, mediaFacts, parseMp4, parseWebm } from "./media-facts.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ---- tiny fixtures built in memory: no binary files in the repo, no ffmpeg needed ----
const be32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([be32(8 + body.length), Buffer.from(type, "latin1"), body]);
};
const mvhd = (ts, dur) => box("mvhd", be32(0), be32(0), be32(0), be32(ts), be32(dur), Buffer.alloc(80));
const tkhd = (w, h) => box("tkhd", be32(0), Buffer.alloc(72), be32(w * 65536), be32(h * 65536));
const mdhd = (ts, dur) => box("mdhd", be32(0), be32(0), be32(0), be32(ts), be32(dur), be32(0));
const hdlr = (kind) => box("hdlr", be32(0), be32(0), Buffer.from(kind, "latin1"), Buffer.alloc(12));
const stsd = (codec) => box("stsd", be32(0), be32(1), box(codec, Buffer.alloc(8)));
const stts = (count, delta) => box("stts", be32(0), be32(1), be32(count), be32(delta));
const trak = (kind, codec, w, h, ts, dur, count, delta) =>
  box("trak", tkhd(w, h), box("mdia", mdhd(ts, dur), hdlr(kind), box("minf", box("stbl", stsd(codec), stts(count, delta)))));

// 2 s of 640x360 video at 30 fps (60 frames of 1000 in a 30000 timescale), optionally with 2 s of audio.
const mp4 = (withAudio) =>
  Buffer.concat([
    box("ftyp", Buffer.from("isom", "latin1"), be32(0)),
    box("moov", mvhd(1000, 2000), trak("vide", "avc1", 640, 360, 30000, 60000, 60, 1000), ...(withAudio ? [trak("soun", "mp4a", 0, 0, 44100, 88200, 87, 1024)] : [])),
    box("mdat", Buffer.alloc(16)),
  ]);

const el = (idBytes, payload) => Buffer.concat([Buffer.from(idBytes), Buffer.from([0x80 | payload.length]), payload]);
const uint = (n) => Buffer.from([n >> 8, n & 255]);
const entry = (type, extra = []) => el([0xae], Buffer.concat([el([0x83], Buffer.from([type])), ...extra]));
const webm = (withAudio) => {
  const duration = Buffer.alloc(4);
  duration.writeFloatBE(2000, 0); // 2000 ticks of the default 1 ms scale = 2 s
  const video = entry(1, [el([0x86], Buffer.from("V_VP9")), el([0x23, 0xe3, 0x83], Buffer.from([0x01, 0xfc, 0xa9, 0xf0].slice(0, 4))), el([0xe0], Buffer.concat([el([0xb0], uint(320)), el([0xba], uint(180))]))]);
  const audio = entry(2, [el([0x86], Buffer.from("A_OPUS"))]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], Buffer.concat([video, ...(withAudio ? [audio] : [])]));
  const info = el([0x15, 0x49, 0xa9, 0x66], el([0x44, 0x89], duration));
  const segment = Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), info, tracks]);
  return Buffer.concat([el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from("webm"))), segment]);
};

test("MP4 without audio: silent, resolution, fps and duration", () => {
  const f = parseMp4(mp4(false));
  assert.deepEqual(f.tracks.map((t) => t.kind), ["video"]);
  assert.equal(f.seconds, 2);
  assert.equal(f.tracks[0].width, 640);
  assert.equal(f.tracks[0].height, 360);
  assert.equal(f.tracks[0].fps, 30);
});

test("MP4 with audio: the track list has both", () => {
  const f = parseMp4(mp4(true));
  assert.deepEqual(f.tracks.map((t) => `${t.kind}/${t.codec}`), ["video/avc1", "audio/mp4a"]);
});

test("WebM without and with audio", () => {
  const silent = parseWebm(webm(false));
  assert.deepEqual(silent.tracks.map((t) => t.kind), ["video"]);
  assert.equal(silent.seconds, 2);
  assert.equal(silent.tracks[0].width, 320);
  assert.equal(silent.tracks[0].height, 180);
  const loud = parseWebm(webm(true));
  assert.deepEqual(loud.tracks.map((t) => t.kind), ["video", "audio"]);
});

test("mediaFacts on files: audio yes/no and the printed lines (Node reader forced)", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-facts-"));
  try {
    const silent = join(dir, "silent.mp4");
    const loud = join(dir, "loud.webm");
    writeFileSync(silent, mp4(false));
    writeFileSync(loud, webm(true));
    const a = mediaFacts(silent, { useFfprobe: false });
    assert.equal(a.hasAudio, false);
    assert.equal(a.source, "node reader");
    assert.equal(a.bytes, mp4(false).length);
    const text = formatFacts(a);
    assert.match(text, /resolution: 640x360/);
    assert.match(text, /frame rate: 30 fps/);
    assert.match(text, /audio: no \(silent\)/);
    assert.equal(mediaFacts(loud, { useFfprobe: false }).hasAudio, true);
    assert.match(formatFacts(mediaFacts(loud, { useFfprobe: false })), /audio: yes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that is not a video fails with one line, not a stack", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-facts-"));
  try {
    const bad = join(dir, "notes.txt");
    writeFileSync(bad, "hello, this is not a video file");
    assert.throws(() => execFileSync("node", [join(here, "media-facts.mjs"), bad, "--no-ffprobe"], { stdio: "pipe" }), (e) => e.status === 1 && /media-facts: .*not an MP4/.test(String(e.stderr)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed promo video is silent, 1920x1080 (the fact behind BOS-1569)", () => {
  const f = mediaFacts(join(here, "..", "docs", "promo", "boss-man-promo.mp4"), { useFfprobe: false });
  assert.equal(f.hasAudio, false);
  assert.equal(`${f.width}x${f.height}`, "1920x1080");
});
