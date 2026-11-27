#!/usr/bin/env node
// One supported way to screenshot the web build from an agent run (BOS-1060).
//
//   node scripts/screenshot.mjs --route "#settings/funding" --width 1667 --out shot.png --wait ".funding h2"
//   node scripts/screenshot.mjs --url http://host:3100/#board/p1 --width 380 --out shot.png --wait ".board"
//   node scripts/screenshot.mjs --route "#watchdog/c1" --wait "#watchdog-h" --click "#test-rules" --click "#run" \
//        --wait-after ".rule-result" --api my-api.json --out shot.png
//
// What it does: serves the built web app (apps/web/dist, build it first with `pnpm --filter @boss-man/web build`)
// from a tiny in-process server on 127.0.0.1, answers every /api/* request from fixtures (a built-in set that
// lets the app boot as a signed-in owner with one company and one project, merged with --api FILE: a JSON map
// of "/api/path" -> response body; an unknown path gets {}), opens it in headless Chromium at --width, waits for
// the --wait CSS selector (never a fixed time), and writes a PNG. With --api (and no --url) the PNG carries a
// `bossman-screenshot` = `api=seeded` text chunk (png-marker.mjs): the move to review counts only marked
// before/after shots for a screen change (BOS-2511, DR-075). An --out ending .jpg/.jpeg writes an unmarked JPEG.
//
// Why it is built this way (the blank/failed captures on BOS-1053):
//  - /dev/shm on the runner is small (64 MB) and can be nearly full. Chromium's default of using it for renderer
//    memory then gives a blank page. We pass --disable-dev-shm-usage so it uses the temp folder instead, and
//    never point anything at /dev/shm.
//  - Chromium and Playwright write a profile and temp files to TMPDIR. We make one folder, point TMPDIR at it
//    and remove it on exit (also on a signal), so nothing is left behind and no path outside it is touched.
//  - Chromium is started through a wrapper that sets `ulimit -c 0`, so a crash leaves no 28 MB core dump.
//  - A fixed sleep is a guess; waiting for a named element is not.
//
// Options: --route R (hash route like "#board/p1", default "#board/p1") | --url U (full URL, skips the local server)
//          --width N (CSS px, default 1280) --height N (default 900) --ratio N (device pixel ratio, default 1)
//          --touch (touch + mobile) --full-page --wait SELECTOR (required) --timeout MS (default 20000)
//          --out FILE (required) --dist DIR (default apps/web/dist) --api FILE
//          --click SELECTOR (repeatable: after --wait, each is waited for until visible, within --timeout, then
//          clicked, in the order given; for a state behind a button, tab or fold, BOS-2547)
//          --wait-after SELECTOR (waited for after the clicks, before the shot)
//          --key NAME (repeatable: a Playwright key, e.g. Tab or Control+k, pressed after the clicks and before
//          --wait-after; for a state a keyboard brings up, BOS-2690)
// Exit 0 with the output path on the last line; non-zero with one error line otherwise.
// Playwright is a global tool on the runner, not a project dependency; BOSSMAN_CHROMIUM overrides the browser.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addPngText, SCREENSHOT_MARKER_KEY, SCREENSHOT_MARKER_SEEDED } from "./png-marker.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const o = { route: "#board/p1", width: 1280, height: 900, ratio: 1, touch: false, fullPage: false, timeout: 20000, dist: join(repoRoot, "apps/web/dist"), clicks: [], keys: [] };
  const num = (k, v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) fail(`${k} needs a positive number, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--route") o.route = val();
    else if (a === "--url") o.url = val();
    else if (a === "--width") o.width = num(a, val());
    else if (a === "--height") o.height = num(a, val());
    else if (a === "--ratio") o.ratio = num(a, val());
    else if (a === "--timeout") o.timeout = num(a, val());
    else if (a === "--wait") o.wait = val();
    else if (a === "--click") o.clicks.push(val());
    else if (a === "--key") o.keys.push(val());
    else if (a === "--wait-after") o.waitAfter = val();
    else if (a === "--out") o.out = val();
    else if (a === "--dist") o.dist = resolve(val());
    else if (a === "--api") o.api = val();
    else if (a === "--touch") o.touch = true;
    else if (a === "--full-page") o.fullPage = true;
    else fail(`unknown option ${a}`);
  }
  if (!o.wait) fail("--wait SELECTOR is required (the element that shows the page has loaded)");
  if (!o.out) fail("--out FILE is required");
  return o;
}

function fail(msg) {
  throw new Error(msg); // thrown, not process.exit, so main's finally still removes the temp folder
}

// Enough for the app to boot signed in on the board; --api adds or overrides paths.
const agent = { id: "a1", name: "Bungle - Web Developer", role: "engineer", status: "idle", agentKind: "developer", companyId: "c1", model: null, fundingSourceId: null, paused: false, starred: false, duty: null };
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", standingRules: "", agents: [agent] };
const project = { id: "p1", companyId: "c1", name: "Development", repoUrl: null, defaultBranch: "main", verifyCommand: null, deepVerifyCommand: null, landing: "merge", gitHost: null, gitApiBase: null, starred: false, ticketCostCapMicros: null, monthlyCapMicros: null, archivedAt: null };
const columns = ["ready", "in_progress", "blocked", "review", "done"].map((s, i) => ({ id: `col${i}`, name: s, systemState: s, wipLimit: null, tickets: [] }));
const DEFAULT_API = {
  "/api/setup": { needsSetup: false },
  "/api/me": { username: "owner" },
  "/api/companies": [company],
  "/api/decisions": [],
  "/api/decisions/advised": [],
  "/api/decisions/with-team": [],
  "/api/decisions/closed-notices": [],
  "/api/runs": [],
  "/api/notifications": { items: [], unread: 0 },
  "/api/maintenance": {},
  "/api/feedback/unprocessed": {},
  "/api/setup-progress": { dismissed: true },
  "/api/companies/c1/merge-queue": { waitingCount: 0, stuckCount: 0 },
  "/api/companies/c1/projects": [project],
  "/api/projects/p1/board": { project, workingAgents: 0, withoutTicket: [], columns },
  "/api/companies/c1/features": { features: [], criteria: [] },
  "/api/companies/c1/objectives": { objectives: [], keyResults: [] },
  "/api/companies/c1/review-policy": {},
  "/api/companies/c1/watchdog": { settings: { enabled: false }, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0 },
  "/api/policy": {},
  // List endpoints: an unknown path answers {}, and a screen that reads .length from it throws, so list the ones known to be read.
  "/api/funding-sources": [],
  "/api/budgets": [],
  "/api/secrets": [],
  "/api/projects/p1/spend": { monthMicros: 0, totalMicros: 0, ticketCostCapMicros: null, monthlyCapMicros: null, monthStart: "2026-11-01T00:00:00.000Z", topTickets: [] },
  "/api/decisions/tally": {},
  "/api/kill-switch": {},
};
// For reference: Settings → Funding is route "#settings/c1/funding", wait for "#funding-h".

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

function serve(dist, api) {
  const root = resolve(dist);
  return new Promise((ok, bad) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (path.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(api[path] ?? {}));
        return;
      }
      let file = normalize(join(root, path === "/" ? "index.html" : path));
      if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    });
    server.once("error", bad);
    server.listen(0, "127.0.0.1", () => ok(server));
  });
}

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try {
    return req("playwright");
  } catch {
    // Global tool: look in the global node_modules.
  }
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return createRequire(join(root, "x.js"))("playwright");
  } catch {
    fail("Playwright is not installed (npm root -g has no playwright)");
  }
}

// Chromium puts a unix socket at <TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket, and a unix socket path
// can't pass 107 characters. The run's own TMPDIR on the runner is already ~80, so Chromium died with "Socket
// path too long". Take the first base short enough for it (a short /tmp first, then the run's TMPDIR).
// The folder itself stays in the run's own temp area; when that path is too long, TMPDIR is a short symlink to it
// (kept in /dev/shm, which holds only the link, never Chromium's data) and `work.link` is removed with it.
function makeWorkDir() {
  const SOCKET_TAIL = "/org.chromium.Chromium.XXXXXX/SingletonSocket".length;
  const real = mkdtempSync(join(tmpdir(), "bm-shot-"));
  if (real.length + SOCKET_TAIL <= 100) return { dir: real, real, link: null };
  for (const base of ["/tmp", "/dev/shm", "/var/tmp"]) {
    const link = join(base, `bm-${process.pid}`);
    try {
      symlinkSync(real, link);
      return { dir: link, real, link };
    } catch {
      // not writable here; try the next base
    }
  }
  rmSync(real, { recursive: true, force: true });
  fail("the temp folder path is too long for Chromium's socket (107 characters) and no short folder is writable for a link; set TMPDIR to a shorter folder");
}

function findChromium() {
  if (process.env.BOSSMAN_CHROMIUM) return process.env.BOSSMAN_CHROMIUM;
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) if (existsSync(p)) return p;
  return undefined; // Playwright's own download, if any
}

// The steps between load and shot: --wait, then each --click in order, then each --key, then --wait-after.
// Exported so screenshot.test.mjs can drive it with a fake page (GitHub's script-test job has no browser).
export async function afterLoad(page, o, target) {
  const visible = async (sel, what) => {
    try {
      await page.waitForSelector(sel, { state: "visible", timeout: o.timeout });
    } catch {
      // Keep what the page showed, so a wrong selector or a missing fixture can be seen rather than guessed.
      mkdirSync(dirname(resolve(o.out)), { recursive: true });
      await page.screenshot({ path: `${o.out}.failed.png` }).catch(() => {});
      fail(`${what}"${sel}" did not appear within ${o.timeout} ms at ${target}`);
    }
  };
  await visible(o.wait, "");
  for (const sel of o.clicks) {
    await visible(sel, "--click ");
    try {
      await page.click(sel, { timeout: o.timeout });
    } catch (e) {
      // Playwright's message runs to many lines (call log); keep the one-line contract.
      fail(`--click "${sel}" could not be clicked at ${target}: ${String(e.message).split("\n")[0]}`);
    }
  }
  for (const key of o.keys ?? []) {
    try {
      await page.keyboard.press(key);
    } catch (e) {
      fail(`--key "${key}" could not be pressed at ${target}: ${String(e.message).split("\n")[0]}`);
    }
  }
  if (o.waitAfter) await visible(o.waitAfter, "--wait-after ");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.url && !existsSync(join(o.dist, "index.html"))) fail(`no web build at ${o.dist}; run: pnpm --filter @boss-man/web build`);
  let api = { ...DEFAULT_API };
  if (o.api) {
    try {
      api = { ...api, ...JSON.parse(readFileSync(o.api, "utf8")) };
    } catch (e) {
      fail(`cannot read --api ${o.api}: ${e.message}`);
    }
  }

  // One folder for everything Chromium and Playwright write; removed in `finally` and on a signal.
  const work = makeWorkDir();
  process.env.TMPDIR = work.dir;
  let server;
  let browser;
  const cleanup = async () => {
    try { await browser?.close(); } catch { /* already gone */ }
    server?.close();
    if (work.link) rmSync(work.link, { force: true });
    await rm(work.real, { recursive: true, force: true });
  };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => cleanup().finally(() => process.exit(130)));

  try {
    const chromium = loadPlaywright().chromium;
    let exe = findChromium();
    if (exe) {
      const wrap = join(work.real, "chromium-nocore.sh");
      writeFileSync(wrap, `#!/bin/sh\nulimit -c 0 2>/dev/null\nexec "${exe}" "$@"\n`);
      chmodSync(wrap, 0o755);
      exe = wrap;
    }
    browser = await chromium.launch({
      executablePath: exe,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
      env: { ...process.env, TMPDIR: work.dir },
    });
    let target = o.url;
    if (!target) {
      server = await serve(o.dist, api);
      target = `http://127.0.0.1:${server.address().port}/${o.route.startsWith("#") ? o.route : `#${o.route.replace(/^\/+/, "")}`}`;
    }
    const page = await browser.newPage({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: o.ratio, hasTouch: o.touch, isMobile: o.touch });
    if (!o.url) await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api[new URL(r.request().url()).pathname] ?? {}) }));
    // A page error is how a missing fixture shows up ("Cannot read properties of undefined"): say which API paths fell back to {}.
    page.on("pageerror", (e) => console.error(`screenshot: page error: ${String(e.message).split("\n")[0]}`));
    page.on("request", (r) => {
      const p = new URL(r.url()).pathname;
      if (!o.url && p.startsWith("/api/") && !(p in api)) console.error(`screenshot: no fixture for ${p}, answered {} (add it with --api FILE)`);
    });
    await page.goto(target, { waitUntil: "load", timeout: o.timeout });
    await afterLoad(page, o, target);
    mkdirSync(dirname(resolve(o.out)), { recursive: true });
    // BOS-2511 (DR-075): a PNG made from seeded --api data carries a marker, which the move to review looks for.
    const jpeg = /\.jpe?g$/i.test(o.out);
    const shot = await page.screenshot({ type: jpeg ? "jpeg" : "png", fullPage: o.fullPage });
    writeFileSync(o.out, !jpeg && o.api && !o.url ? addPngText(shot, SCREENSHOT_MARKER_KEY, SCREENSHOT_MARKER_SEEDED) : shot);
    console.log(resolve(o.out));
  } finally {
    await cleanup();
  }
}

// Run only when started as a script, not when the test imports parseArgs/afterLoad.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`screenshot: ${e.message}`);
    process.exit(1);
  });
}
