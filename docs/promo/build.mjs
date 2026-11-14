#!/usr/bin/env node
// Assemble the promo video from the recorded scenes (BOS-1433): title and end cards, a caption under each scene,
// short fades, one H.264 MP4 (1920x1080, 30 fps, +faststart) and a poster PNG.
//
//   FFMPEG=/path/to/ffmpeg OUT=$BOSSMAN_SCRATCH/promo node docs/promo/build.mjs
//
// Needs the frames from capture.mjs in $OUT/frames. Writes $OUT/boss-man-promo.mp4 and $OUT/poster.png.
// Nothing here makes a picture: cards are plain HTML text in Boss Man's colours, everything else is the real app.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./lib.mjs";
import { cards, order } from "./cards.mjs";
import { scenes } from "./scenes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const logo = resolve(here, "../../assets/brand/boss-mark-512.png");
const out = process.env.OUT;
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
if (!out) { console.error("set OUT"); process.exit(2); }
const work = join(out, "build");
mkdirSync(work, { recursive: true });

const BG = "#252b36";
const page = (inner, extra = "") => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:1920px;height:1080px;background:${extra ? "transparent" : BG};font-family:"IBM Plex Sans","Liberation Sans",Arial,sans-serif;color:#f2f4f8}
  .c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:34px}
  h1{font-size:76px;line-height:1.12;margin:0;max-width:1500px;font-weight:700}
  p{font-size:38px;margin:0;color:#aeb7c6;max-width:1400px}
  em{font-style:normal;color:#ffab28}
  img{height:210px}
  .cap{position:absolute;left:0;right:0;bottom:46px;display:flex;justify-content:center}
  .cap span{background:rgba(20,24,31,.92);border:2px solid rgba(255,171,40,.55);color:#fff;font-size:38px;line-height:1.3;padding:16px 34px;border-radius:16px;max-width:1560px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.45)}
</style>${inner}`;

const browser = await openBrowser();
const shot = async (html, file, transparent = false) => {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.setContent(html);
  await p.screenshot({ path: file, omitBackground: transparent });
  await p.close();
};
const logoUri = "data:image/png;base64," + readFileSync(logo).toString("base64");
for (const c of cards) {
  await shot(page(`<div class="c"><img src="${logoUri}" alt=""><h1>${c.title}</h1><p>${c.sub}</p></div>`), join(work, `${c.id}.png`));
}
for (const s of scenes) {
  await shot(page(`<div class="cap"><span>${s.caption}</span></div>`, "t"), join(work, `${s.id}-cap.png`), true);
}
await browser.close();

const run = (args) => execFileSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const FADE = 0.35;
// Hold the last frame of each scene this long, so the caption can be read before the next scene.
const TAIL = 1.7;
const clips = [];
for (const id of order) {
  const clip = join(work, `${id}.mp4`);
  const card = cards.find((c) => c.id === id);
  if (card) {
    run(["-loop", "1", "-t", String(card.seconds), "-i", join(work, `${id}.png`),
      "-vf", `fps=30,fade=t=in:st=0:d=${FADE},fade=t=out:st=${card.seconds - FADE}:d=${FADE},format=yuv420p`,
      "-c:v", "libx264", "-crf", "20", "-preset", "medium", clip]);
  } else {
    const s = scenes.find((x) => x.id === id);
    const dir = join(out, "frames", id);
    if (!existsSync(join(dir, "frames.txt"))) throw new Error(`no frames for ${id}; run capture.mjs first`);
    // Total length of the take, to place the fade-out.
    const txt = readFileSync(join(dir, "frames.txt"), "utf8");
    const secs = TAIL + [...txt.matchAll(/duration ([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
    const fit = s.phone
      ? `scale=-2:910:flags=lanczos,pad=1920:1080:(ow-iw)/2:16:color=${BG}`
      : `scale=1920:1080:flags=lanczos`;
    run(["-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt"), "-loop", "1", "-i", join(work, `${id}-cap.png`),
      "-filter_complex", `[0:v]fps=30,${fit},tpad=stop_mode=clone:stop_duration=${TAIL},format=yuv420p[v];[1:v]format=rgba[c];[v][c]overlay=0:0:shortest=1,fade=t=in:st=0:d=${FADE},fade=t=out:st=${Math.max(0, secs - FADE).toFixed(2)}:d=${FADE},format=yuv420p`,
      "-c:v", "libx264", "-crf", "20", "-preset", "medium", clip]);
  }
  clips.push(clip);
}
const list = join(work, "list.txt");
writeFileSync(list, clips.map((c) => `file '${c}'`).join("\n") + "\n");
const mp4 = join(out, "boss-man-promo.mp4");
run(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", mp4]);
console.log("wrote", mp4, (statSync(mp4).size / 1e6).toFixed(1), "MB");
