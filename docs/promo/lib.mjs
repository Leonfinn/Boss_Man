// Helpers for the promo video capture (BOS-1433). Everything on screen is the real Boss Man web app running
// against a throwaway server with made-up Fernleaf data; this file only drives the browser and records it.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Playwright is a global tool on the runner, not a project dependency.
const require = createRequire(import.meta.url);
export const playwright = require(process.env.PLAYWRIGHT_DIR ?? "/usr/local/lib/node_modules/playwright");

// The clock the page sees: fixed, so "2m ago" labels do not drift between takes.
export const FIXED_TIME = "2026-11-14T10:30:00Z";

// A small pointer dot with a click ripple drawn over the page (headless Chromium draws no mouse pointer).
const POINTER_JS = `(() => {
  if (window.__pointer) return;
  const dot = document.createElement("div");
  dot.style.cssText = "position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,170,40,.9);border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none;left:-50px;top:-50px;transition:transform .12s";
  document.documentElement.appendChild(dot);
  window.__pointer = dot;
  addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", (e) => {
    dot.style.transform = "scale(.7)";
    const r = document.createElement("div");
    r.style.cssText = "position:fixed;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:3px solid rgba(255,170,40,.95);pointer-events:none;left:" + e.clientX + "px;top:" + e.clientY + "px;transition:transform .5s ease-out,opacity .5s ease-out";
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = "scale(4)"; r.style.opacity = "0"; });
    setTimeout(() => r.remove(), 600);
  }, true);
  addEventListener("mouseup", () => { dot.style.transform = ""; }, true);
})();`;

export async function openBrowser() {
  const browser = await playwright.chromium.launch({
    executablePath: process.env.BOSSMAN_CHROMIUM ?? "/usr/bin/chromium",
    // /dev/shm is small on the runner; keep renderer memory out of it (same flags as scripts/screenshot.mjs).
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--hide-scrollbars"],
  });
  return browser;
}

// One signed-in browser window. `phone` gives the owner's phone-like size (390 CSS px wide, ratio 3).
export async function openWindow(browser, base, user, pass, phone = false) {
  const ctx = await browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
      : { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }, // the screencast gives CSS-pixel frames, so 1920 CSS px = a sharp 1080p frame
  );
  const page = await ctx.newPage();
  await page.clock.install({ time: FIXED_TIME });
  await page.clock.resume();
  await page.goto(base + "/");
  const res = await page.request.post(base + "/api/login", { data: { username: user, password: pass } });
  if (!res.ok()) throw new Error("login failed: " + res.status());
  await page.reload();
  await page.addInitScript(POINTER_JS);
  await page.evaluate(POINTER_JS);
  return { ctx, page };
}

// The driver a scene script gets: a pointer that glides, clicks, and deliberate holds for pacing.
export function driver(page) {
  let x = 800, y = 450;
  const api = {
    page,
    // A hold is a pacing choice for the viewer, not a wait for the app: use waitFor for readiness.
    hold: (ms) => new Promise((r) => setTimeout(r, ms)),
    waitFor: (sel, timeout = 15000) => page.locator(sel).first().waitFor({ state: "visible", timeout }),
    async goto(route, waitSel) {
      await page.evaluate((r) => { window.location.hash = "#/" + r; }, route);
      if (waitSel) await api.waitFor(waitSel);
    },
    async moveTo(loc, steps = 28) {
      const b = await loc.boundingBox();
      if (!b) throw new Error("no box to move to");
      const tx = b.x + b.width / 2, ty = b.y + Math.min(b.height / 2, 24);
      await page.mouse.move(tx, ty, { steps });
      x = tx; y = ty;
    },
    async click(loc) {
      await loc.scrollIntoViewIfNeeded();
      await api.moveTo(loc);
      await api.hold(250);
      await page.mouse.down();
      await api.hold(80);
      await page.mouse.up();
    },
    async tap(loc) {
      // Phone: a real touch on the element.
      await loc.scrollIntoViewIfNeeded();
      await loc.tap();
    },
    async type(loc, text, delay = 70) {
      await api.click(loc);
      await page.keyboard.type(text, { delay });
    },
    async smoothScroll(px, ms = 1500) {
      const n = Math.max(1, Math.round(ms / 50));
      for (let i = 0; i < n; i++) { await page.mouse.wheel(0, px / n); await api.hold(50); }
    },
  };
  return api;
}

// Record a page with the DevTools screencast: lossless-quality JPEG frames with timestamps, written to `dir`.
// Returns a function that stops and writes frames.txt (an ffmpeg concat list with each frame's duration).
export async function startRecording(ctx, page, dir, { poll = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const frames = [];
  let n = 0;
  if (poll) {
    // The screencast only gives CSS-pixel frames. For the phone (ratio 3) take real screenshots in a loop instead:
    // fewer frames a second, but sharp.
    let running = true;
    const loop = (async () => {
      while (running) {
        const t = Date.now() / 1000;
        const buf = await page.screenshot({ type: "jpeg", quality: 90 }).catch(() => null);
        if (!buf) break;
        const name = `f${String(n++).padStart(5, "0")}.jpg`;
        writeFileSync(join(dir, name), buf);
        frames.push({ name, t });
      }
    })();
    return async () => {
      running = false;
      await loop;
      return finish(dir, frames, Date.now() / 1000);
    };
  }
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const name = `f${String(n++).padStart(5, "0")}.jpg`;
    writeFileSync(join(dir, name), Buffer.from(data, "base64"));
    frames.push({ name, t: metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 3200, maxHeight: 3200, everyNthFrame: 1 });
  return async () => {
    const end = Date.now() / 1000;
    await cdp.send("Page.stopScreencast").catch(() => {});
    return finish(dir, frames, end);
  };
}

function finish(dir, frames, end) {
  if (!frames.length) throw new Error("no frames recorded");
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(end, f.t + 0.05);
    lines.push(`file ${f.name}`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  lines.push(`file ${frames[frames.length - 1].name}`);
  writeFileSync(join(dir, "frames.txt"), lines.join("\n") + "\n");
  return frames.length;
}

// The public-repo safety scan: text on screen must hold nothing that looks like real host data or a secret.
const BAD = [
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, "an IP address"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, "an email address"],
  [/\b(?:sk|pk|ghp|gho|xox[bp]|AKIA)[-_A-Za-z0-9]{12,}/, "something shaped like a key"],
  [/\b[a-z0-9-]+\.(?:com|net|org|io|dev|lan|local|internal)\b/i, "a host name"],
];
const ALLOWED_HOSTS = /\b(?:example\.com|github\.com)\b/gi;
export async function scanPage(page, label) {
  const text = await page.evaluate(() => document.body.innerText);
  const clean = text.replace(ALLOWED_HOSTS, "").replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b(?=\s*(?:%|ms|KiB|MiB|GiB))/g, "");
  for (const [re, what] of BAD) {
    const m = clean.match(re);
    if (m) throw new Error(`scene "${label}": the page text holds ${what}: "${m[0]}". Not recording it.`);
  }
}
