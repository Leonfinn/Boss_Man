#!/usr/bin/env node
// Media facts from a tool, not from memory (BOS-1569): duration, file size, resolution, frame rate and the track list
// (audio yes/no) of a video file. Anything said about a video in owner-facing text quotes this output.
//
//   node scripts/media-facts.mjs FILE [--json] [--no-ffprobe]
//
// Uses ffprobe when it is on PATH; otherwise (or with --no-ffprobe) reads the MP4/MOV or WebM/MKV boxes itself in
// Node, so it works on the runner, which has no ffprobe. The "source" line says which one answered.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const u32 = (b, o) => b.readUInt32BE(o);
const u64 = (b, o) => Number(b.readBigUInt64BE(o));

// ---- MP4 / MOV ----
// Container boxes we descend into; everything else is skipped by its size.
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

function* mp4Boxes(buf, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(buf, o);
    const type = buf.toString("latin1", o + 4, o + 8);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = u64(buf, o + 8);
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) return;
    yield { type, body: o + header, end: o + size };
    o += size;
  }
}

export function parseMp4(buf) {
  const tracks = [];
  let movieTimescale = 0;
  let movieDuration = 0;
  const walk = (start, end, cur) => {
    for (const box of mp4Boxes(buf, start, end)) {
      if (box.type === "trak") {
        const t = { kind: "other", codec: undefined, width: 0, height: 0, timescale: 0, duration: 0, samples: 0, sampleTime: 0 };
        tracks.push(t);
        walk(box.body, box.end, t);
      } else if (MP4_CONTAINERS.has(box.type)) walk(box.body, box.end, cur);
      else if (box.type === "mvhd") {
        const v = buf[box.body];
        movieTimescale = u32(buf, box.body + (v === 1 ? 20 : 12));
        movieDuration = v === 1 ? u64(buf, box.body + 24) : u32(buf, box.body + 16);
      } else if (cur && box.type === "tkhd") {
        // width and height are the last 8 bytes, 16.16 fixed point
        cur.width = Math.round(u32(buf, box.end - 8) / 65536);
        cur.height = Math.round(u32(buf, box.end - 4) / 65536);
      } else if (cur && box.type === "mdhd") {
        const v = buf[box.body];
        cur.timescale = u32(buf, box.body + (v === 1 ? 20 : 12));
        cur.duration = v === 1 ? u64(buf, box.body + 24) : u32(buf, box.body + 16);
      } else if (cur && box.type === "hdlr") {
        const h = buf.toString("latin1", box.body + 8, box.body + 12);
        cur.kind = h === "vide" ? "video" : h === "soun" ? "audio" : h === "text" || h === "sbtl" || h === "subt" ? "subtitle" : h;
      } else if (cur && box.type === "stsd") {
        cur.codec = buf.toString("latin1", box.body + 12, box.body + 16);
      } else if (cur && box.type === "stts") {
        const n = u32(buf, box.body + 4);
        for (let i = 0; i < n && box.body + 8 + i * 8 + 8 <= box.end; i++) {
          const count = u32(buf, box.body + 8 + i * 8);
          cur.samples += count;
          cur.sampleTime += count * u32(buf, box.body + 12 + i * 8);
        }
      }
    }
  };
  walk(0, buf.length, null);
  if (!tracks.length) throw new Error("no moov/trak boxes: not an MP4/MOV file, or it is damaged");
  const out = tracks.map((t) => {
    const seconds = t.timescale ? t.duration / t.timescale : 0;
    const r = { kind: t.kind, codec: t.codec, seconds };
    if (t.kind === "video") {
      Object.assign(r, { width: t.width, height: t.height });
      if (t.sampleTime > 0) r.fps = (t.samples * t.timescale) / t.sampleTime;
    }
    return r;
  });
  const seconds = movieTimescale ? movieDuration / movieTimescale : Math.max(0, ...out.map((t) => t.seconds));
  return { container: "mp4", seconds, tracks: out };
}

// ---- WebM / Matroska ----
function vint(buf, o, keepMarker) {
  const first = buf[o];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error("bad EBML number");
  let v = keepMarker ? first : first & (0xff >> len);
  let unknown = !keepMarker && (first & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + buf[o + i];
    if (buf[o + i] !== 0xff) unknown = false;
  }
  return { value: v, len, unknown };
}

const MKV_MASTERS = new Set([0x18538067 /* Segment */, 0x1549a966 /* Info */, 0x1654ae6b /* Tracks */, 0xae /* TrackEntry */, 0xe0 /* Video */]);

export function parseWebm(buf) {
  let scale = 1000000;
  let duration = 0;
  const tracks = [];
  const walk = (start, end, cur) => {
    let o = start;
    while (o < end) {
      const id = vint(buf, o, true);
      const sz = vint(buf, o + id.len, false);
      const body = o + id.len + sz.len;
      const stop = sz.unknown ? end : Math.min(end, body + sz.value);
      if (id.value === 0x1f43b675) return; // Cluster: the headers are all before it
      if (id.value === 0xae) {
        const t = { kind: "other" };
        tracks.push(t);
        walk(body, stop, t);
      } else if (MKV_MASTERS.has(id.value)) walk(body, stop, cur);
      else if (id.value === 0x2ad7b1) scale = readUint(buf, body, stop);
      else if (id.value === 0x4489) duration = readFloat(buf, body, stop);
      else if (cur && id.value === 0x83) cur.kind = { 1: "video", 2: "audio", 17: "subtitle" }[readUint(buf, body, stop)] ?? "other";
      else if (cur && id.value === 0x86) cur.codec = buf.toString("latin1", body, stop);
      else if (cur && id.value === 0xb0) cur.width = readUint(buf, body, stop);
      else if (cur && id.value === 0xba) cur.height = readUint(buf, body, stop);
      else if (cur && id.value === 0x23e383) cur.defaultDuration = readUint(buf, body, stop);
      o = stop;
    }
  };
  walk(0, buf.length, null);
  if (!tracks.length) throw new Error("no Tracks element: not a WebM/Matroska file, or it is damaged");
  const out = tracks.map((t) => {
    const r = { kind: t.kind, codec: t.codec };
    if (t.kind === "video") {
      Object.assign(r, { width: t.width, height: t.height });
      if (t.defaultDuration) r.fps = 1e9 / t.defaultDuration;
    }
    return r;
  });
  return { container: "webm", seconds: (duration * scale) / 1e9, tracks: out };
}

const readUint = (b, s, e) => {
  let v = 0;
  for (let i = s; i < e; i++) v = v * 256 + b[i];
  return v;
};
const readFloat = (b, s, e) => (e - s === 4 ? b.readFloatBE(s) : e - s === 8 ? b.readDoubleBE(s) : 0);

// ---- ffprobe ----
export function viaFfprobe(file, run = execFileSync) {
  const json = JSON.parse(run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { encoding: "utf8", timeout: 30000 }));
  const tracks = (json.streams ?? []).map((s) => {
    const kind = s.codec_type === "video" ? "video" : s.codec_type === "audio" ? "audio" : s.codec_type === "subtitle" ? "subtitle" : "other";
    const r = { kind, codec: s.codec_name, seconds: Number(s.duration) || undefined };
    if (kind === "video") {
      Object.assign(r, { width: s.width, height: s.height });
      const [n, d] = String(s.avg_frame_rate || s.r_frame_rate || "0/1").split("/").map(Number);
      if (n && d) r.fps = n / d;
    }
    return r;
  });
  return { container: json.format?.format_name, seconds: Number(json.format?.duration) || 0, tracks };
}

export function mediaFacts(file, { useFfprobe = true } = {}) {
  const bytes = statSync(file).size;
  let facts;
  let source = "node reader";
  if (useFfprobe) {
    try {
      facts = viaFfprobe(file);
      source = "ffprobe";
    } catch {
      // not installed, or it could not read the file: fall back to the Node reader
    }
  }
  if (!facts) {
    const buf = readFileSync(file);
    const isEbml = buf.length > 4 && buf.readUInt32BE(0) === 0x1a45dfa3;
    facts = isEbml ? parseWebm(buf) : parseMp4(buf);
  }
  const video = facts.tracks.find((t) => t.kind === "video");
  const audio = facts.tracks.filter((t) => t.kind === "audio");
  return {
    file,
    source,
    container: facts.container,
    bytes,
    seconds: facts.seconds,
    width: video?.width,
    height: video?.height,
    fps: video?.fps,
    hasVideo: Boolean(video),
    hasAudio: audio.length > 0,
    tracks: facts.tracks,
  };
}

export function formatFacts(f) {
  const round = (n, d = 2) => (n === undefined ? "unknown" : String(Math.round(n * 10 ** d) / 10 ** d));
  const lines = [
    `file: ${f.file}`,
    `source: ${f.source} (${f.container})`,
    `size: ${f.bytes} bytes (${round(f.bytes / 1048576)} MiB)`,
    `duration: ${round(f.seconds)} s`,
    `resolution: ${f.width ? `${f.width}x${f.height}` : "none (no video track)"}`,
    `frame rate: ${f.fps ? `${round(f.fps)} fps` : "unknown"}`,
    `audio: ${f.hasAudio ? "yes" : "no (silent)"}`,
    `tracks: ${f.tracks.map((t) => `${t.kind}${t.codec ? `/${t.codec}` : ""}`).join(", ") || "none"}`,
  ];
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node scripts/media-facts.mjs FILE [--json] [--no-ffprobe]");
    process.exit(2);
  }
  try {
    const f = mediaFacts(file, { useFfprobe: !args.includes("--no-ffprobe") });
    console.log(args.includes("--json") ? JSON.stringify(f, null, 2) : formatFacts(f));
  } catch (e) {
    console.error(`media-facts: ${file}: ${e.message}`);
    process.exit(1);
  }
}
