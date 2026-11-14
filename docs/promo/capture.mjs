#!/usr/bin/env node
// Record every scene in scenes.mjs from the real web app on a throwaway server (BOS-1433).
//
//   BASE=http://127.0.0.1:3411 DEMO_USER=demo DEMO_PASSWORD=... OUT=$BOSSMAN_SCRATCH/promo node docs/promo/capture.mjs [sceneId ...]
//
// Frames go to $OUT/frames/<scene>/ (never into the repo). Keep TMPDIR short or Chromium will not start.
import { join } from "node:path";
import { driver, openBrowser, openWindow, scanPage, startRecording } from "./lib.mjs";
import { scenes } from "./scenes.mjs";

const base = process.env.BASE ?? "http://127.0.0.1:3411";
const user = process.env.DEMO_USER ?? "demo";
const pass = process.env.DEMO_PASSWORD;
const out = process.env.OUT;
if (!pass || !out) { console.error("set DEMO_PASSWORD and OUT"); process.exit(2); }
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) { console.error("BASE must be a local throwaway server, got " + base); process.exit(2); }

const only = process.argv.slice(2);
const browser = await openBrowser();
try {
  for (const s of scenes) {
    if (only.length && !only.includes(s.id)) continue;
    const { ctx, page } = await openWindow(browser, base, user, pass, !!s.phone);
    const d = driver(page);
    const stop = await startRecording(ctx, page, join(out, "frames", s.id), { poll: !!s.phone });
    let err;
    try {
      await s.run(d);
      await scanPage(page, s.id);
    } catch (e) { err = e; }
    const n = await stop();
    await ctx.close();
    if (err) { console.error(`${s.id}: FAIL ${err.message}`); process.exitCode = 1; continue; }
    console.log(`${s.id}: ok, ${n} frames`);
  }
} finally {
  await browser.close();
}
