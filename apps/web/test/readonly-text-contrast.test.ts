// A rendering check, not a CSS-text test (BOS-1050): the real built web app is served from `apps/web/dist`
// to Chromium, at the owner's foldable width (Brave, 1667 CSS px, dark theme, the theme the app ships),
// and the standing rules box shown when not editing is measured the way the browser paints it: its text
// colour against its own background is at least 4.5:1, and so is the editor after Edit and the light theme.
//
// The "fault" case puts back the rule that caused it (the box had `background: var(--panel, #f6f6f6)`,
// but --panel was never defined, so it fell back to near-white under the dark theme's pale text) and
// asserts the same measurement fails on it, so this test is proven to catch what it guards.
// Skipped, not failed, where the build or a browser is missing. Screenshots go to BOSSMAN_SCRATCH.
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WEB = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(WEB, "dist");
const built = existsSync(path.join(DIST, "index.html"));
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const W = 1667;
const H = 724;

const RULES =
  "Credentials: never write a token, key or password to a file, a script, a log or a ticket.\n\nEditing files: change files with your file edit/write tools, never with shell one-liners.\n\nBranches: start from origin/main, never from another ticket's unmerged branch.";

const now = () => new Date().toISOString();
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", nextTicketNumber: 12, agents: [], projects: [] };

function answer(p: string): unknown {
  if (p === "/api/setup") return { needsSetup: false };
  if (p === "/api/me") return { username: "owner" };
  if (p === "/api/setup-progress") return { dismissed: true };
  if (p === "/api/companies") return [company];
  if (p === "/api/notifications") return { items: [], unread: 0 };
  if (p === "/api/notifications/unseen") return { count: 0 };
  if (p === "/api/runs" || p === "/api/decisions" || p === "/api/decisions/advised" || p === "/api/decisions/with-team" || p === "/api/decisions/closed-notices") return [];
  if (p === "/api/feedback/unprocessed") return {};
  if (p === "/api/health") return { role: "leader", version: "1.2.0", commit: "aaaaaaaaaaaa", colour: null, startedAt: now() };
  if (p === "/api/bluegreen") return { enabled: false };
  if (p === "/api/kill-switch") return { paused: false };
  if (p === "/api/maintenance") return { on: false, last: null };
  if (p === "/api/runner-report") return { live: [], update: null };
  if (p === "/api/release-watch") return { active: false };
  if (p === "/api/self-deploy") return { enabled: false };
  if (p === "/api/devices") return [];
  if (p === "/api/funding-sources") return [];
  if (p === "/api/companies/c1/projects") return [{ id: "p1", companyId: "c1", name: "Boss Man", starred: false }];
  if (p === "/api/companies/c1/standing-rules") return { text: RULES, by: "CEO", at: now(), max: 2000 };
  if (p === "/api/companies/c1/chapters") return [];
  if (p === "/api/companies/c1/retro-settings") return { hasPm: false, nextAt: null, finishedSince: 0 };
  if (p === "/api/companies/c1/merge-queue") return { waitingCount: 0, stuckCount: 0 };
  if (p.startsWith("/api/decisions/tally")) return { open: 0, waiting: 0 };
  if (p.startsWith("/api/projects/")) return { monthMicros: 0, totalMicros: 0, ticketCostCapMicros: null, monthlyCapMicros: null, monthStart: now(), topTickets: [] };
  return {};
}

let server: Server | undefined;
let base = "";
const type = (f: string) => (f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".html") ? "text/html" : "application/octet-stream");

beforeAll(async () => {
  server = createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (p.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(p)));
      return;
    }
    const file = path.join(DIST, p === "/" ? "index.html" : p);
    const use = existsSync(file) && !file.endsWith(path.sep) ? file : path.join(DIST, "index.html");
    res.writeHead(200, { "content-type": type(use) });
    createReadStream(use).pipe(res);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
// A cold Chromium start on a loaded merge gate took most of the old 30 s test budget (BOS-1627), and each
// test used to pay it. One browser is started once, in beforeAll, with its own generous deadline; every
// test then only opens a page. LIMIT is for the loaded machine: it still ends a hung page, and the
// contrast assertions themselves are unchanged, so an unreadable light theme still fails.
const LIMIT = 120_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharedBrowser: any | null = null;
const launch = async (): Promise<any | null> => sharedBrowser;
beforeAll(async () => {
  if (built) sharedBrowser = await launchChromium();
}, LIMIT);
afterAll(async () => {
  await sharedBrowser?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function launchChromium(): Promise<any | null> {
  let chromium: any;
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * Run in the page (Playwright sends the function itself): an element's text and its background as the
 * browser shows them — its own background, or the first opaque one above it — with the WCAG ratio.
 */
function measureBox(sel: string) {
  const ratio = (a: number[], b: number[]) => {
    const l = (c: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const [hi, lo] = l(a) > l(b) ? [l(a), l(b)] : [l(b), l(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) return { found: false };
  const parse = (v: string): number[] | null => {
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return p.length >= 4 && p[3] === 0 ? null : [p[0]!, p[1]!, p[2]!];
  };
  const text = parse(getComputedStyle(el).color);
  let bg = parse(getComputedStyle(el).backgroundColor);
  for (let n: HTMLElement | null = el; !bg && n; n = n.parentElement) bg = parse(getComputedStyle(n).backgroundColor);
  const r = el.getBoundingClientRect();
  return {
    found: true,
    text,
    bg,
    ratio: text && bg ? ratio(text, bg) : 0,
    width: Math.round(r.width),
    height: Math.round(r.height),
    textLength: (el.textContent ?? "").trim().length,
    fits: r.right <= window.innerWidth + 1 && r.left >= 0,
  };
}

const shots = process.env.BOSSMAN_SCRATCH;
const saveShot = async (name: string, page: any, fullPage = false) => {
  if (!shots) return;
  try {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, name), fullPage });
  } catch {
    /* a screenshot is not the test */
  }
};

const openPage = async (browser: any, hash: string) => {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.goto(`${base}/${hash}`, { waitUntil: "networkidle" });
  return page;
};

/** Wait for an element that has painted (Playwright counts a 0-height element as hidden). */
const waitForSelector = async (page: any, sel: string) => {
  await page.waitForFunction(
    (target: string) => {
      const r = document.querySelector(target)?.getBoundingClientRect();
      return !!r && (r.height > 10 || r.width > 10);
    },
    String(sel),
    { timeout: 15_000 },
  );
};

describe.skipIf(!built)("BOS-1050 read-only text boxes read in dark mode at 1667px", () => {
  it("standing rules: view mode text and box are legible, and so is the editor after Edit", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser, "#/settings/c1/team");
      await waitForSelector(page, "#standing-rules-h ~ .readonly-text");
      await saveShot("bos-1050-standing-rules-after.png", page);
      const view = await page.evaluate(measureBox, "#standing-rules-h ~ .readonly-text");
      expect(view.found).toBe(true);
      expect(view.textLength, "the rules are shown").toBeGreaterThan(100);
      expect(view.text, "text colour is a colour").not.toBeNull();
      expect(view.bg, "the box has an opaque background").not.toBeNull();
      expect(view.ratio, `view mode contrast ${JSON.stringify(view)}`).toBeGreaterThanOrEqual(4.5);
      expect(view.fits, "the box fits the window").toBe(true);

      await page.getByRole("button", { name: "Edit" }).click();
      await waitForSelector(page, "#standing-rules-h ~ textarea");
      await saveShot("bos-1050-standing-rules-edit-after.png", page);
      const edit = await page.evaluate(measureBox, "#standing-rules-h ~ textarea");
      expect(edit.found).toBe(true);
      expect(edit.ratio, `edit mode contrast ${JSON.stringify(edit)}`).toBeGreaterThanOrEqual(4.5);
      await page.close();
    } finally {
      for (const ctx of browser.contexts()) await ctx.close(); // the shared browser itself closes in afterAll
    }
  }, LIMIT);

  it("the light theme keeps the standing rules dark on a light box", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser, "#/settings/c1/team");
      await waitForSelector(page, "#standing-rules-h ~ .readonly-text");
      await page.addStyleTag({
        content:
          ":root { color-scheme: light; --ink: #1d2530; --head: #10161f; --muted: #55606e; --ground: #f4f6f9; --card: #ffffff; --field: #f7f8fa; --raise: #eef1f5; --line: #dde2e9; --line-strong: #cfd6df; --lane: #f0f3f7; }",
      });
      // Wait for the style to be applied (the page's ink colour turns to the light theme's), not a fixed sleep.
      await page.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === "light", undefined, { timeout: 15_000 });
      await saveShot("bos-1050-standing-rules-light.png", page);
      const view = await page.evaluate(measureBox, "#standing-rules-h ~ .readonly-text");
      expect(view.found).toBe(true);
      expect(view.ratio, `light theme contrast ${JSON.stringify(view)}`).toBeGreaterThanOrEqual(4.5);
      await page.close();
    } finally {
      for (const ctx of browser.contexts()) await ctx.close(); // the shared browser itself closes in afterAll
    }
  }, LIMIT);

  it("the import preview's agent instructions use the same shared box", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      // The same markup ReadOnlyText renders, inside an import preview's fold, with the real stylesheet:
      // the page's own server answer for the preview is covered by the page tests; here the box is measured.
      await page.setContent(
        `<html><head><style>${css} body { margin: 0; } main { padding: 24px; max-width: 900px; }</style></head><body><main>
        <section class="card" aria-labelledby="import-h" style="display: flex; flex-direction: column; gap: 14px">
        <h2 id="import-h" style="font-size: 17px; font-weight: 600">Import a company</h2>
        <details><summary>Agents (1) and their instructions</summary><ul><li><strong>Basil - Background Developer</strong>: Developer, claude
        <pre class="readonly-text" aria-label="Basil's instructions" role="note"><span class="readonly-text-body">You build and fix the Boss Man web app (apps/web: React pages, components, styles).</span></pre>
        </li></ul></details></section></main></body></html>`,
        { waitUntil: "domcontentloaded" },
      );
      await page.evaluate(() => { (document.querySelector("details") as HTMLDetailsElement).open = true; });
      await waitForSelector(page, "#import-h ~ details .readonly-text");
      await saveShot("bos-1050-import-instructions-after.png", page);
      const box = await page.evaluate(measureBox, "#import-h ~ details .readonly-text");
      expect(box.found).toBe(true);
      expect(box.textLength).toBeGreaterThan(50);
      expect(box.ratio, `import instructions contrast ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(4.5);
      await page.close();
    } finally {
      for (const ctx of browser.contexts()) await ctx.close(); // the shared browser itself closes in afterAll
    }
  }, LIMIT);

  it("catches the fault it guards: the old near-white --panel box fails the same measurement", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await openPage(browser, "#/settings/c1/team");
      await waitForSelector(page, "#standing-rules-h ~ .readonly-text");
      await page.addStyleTag({ content: "#standing-rules-h ~ .readonly-text { background: var(--panel, #f6f6f6); border: 0; }" });
      await page.waitForFunction(() => getComputedStyle(document.querySelector("#standing-rules-h ~ .readonly-text")!).borderTopWidth === "0px", undefined, { timeout: 15_000 });
      const old = await page.evaluate(measureBox, "#standing-rules-h ~ .readonly-text");
      expect(old.found).toBe(true);
      expect(old.ratio, `the old box must fail ${JSON.stringify(old)}`).toBeLessThan(4.5);
      await page.close();
    } finally {
      for (const ctx of browser.contexts()) await ctx.close(); // the shared browser itself closes in afterAll
    }
  }, LIMIT);
});
