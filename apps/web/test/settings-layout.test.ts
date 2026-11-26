// Rendering check for the new Settings menu (BOS-1019, from BOS-1018 §3): at the owner's desktop (Safari
// 1550×1594), the foldable (Brave 1667×724, touch) and a phone (380 px) the menu is a list of links, not a tab
// row; the current page is marked aria-current="page" and shown by a bar and bold as well as colour; the wide
// layout is a 228 px menu column beside the page, the foldable fits its 724 px, and on the phone #/settings opens
// on the menu with each row carrying its hint. Runs the real built web app in Chromium, not a CSS-text test.
//
// Skipped, not failed, where the build or a browser is missing. With BOSSMAN_SCRATCH set it writes the screenshots
// there (never into the repo).
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WEB = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(WEB, "dist");
const foldable = JSON.parse(readFileSync(new URL("./device-profiles/owner-brave-foldable.json", import.meta.url), "utf8")) as {
  readings: Array<{ width: number; height: number; pixelRatio: number; coarsePointer: boolean; units: { vh: number } }>;
};
const fp = foldable.readings[0]!;
const built = existsSync(path.join(DIST, "index.html"));

const now = () => new Date().toISOString();
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOSS", nextTicketNumber: 12, agents: [], projects: [] };

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
  if (p === "/api/run-limits") return { instance: 8, company: 4, background: 2, defaults: { instance: 8, company: 4, background: 2 } };
  if (p === "/api/settings/check-queue") return { mode: "legacy", slots: 1, maxSlots: 4, defaultSlots: 1, runnersTooOld: [] };
  if (p === "/api/private-details") return { total: 0, counts: {} };
  if (p === "/api/devices") return [];
  if (p === "/api/netguard-allow") return { report: null };
  if (p === "/api/host-facts") return { hostName: "host", reportedAt: now(), ownerFacts: [], facts: {} };
  if (p === "/api/companies/c1/review-policy")
    return {
      trivial: { planApprover: "none", reviewer: "ceo", ownerSignoff: false },
      low: { planApprover: "ceo", reviewer: "ceo", ownerSignoff: false },
      medium: { planApprover: "ceo", reviewer: "senior-dev", ownerSignoff: false },
      high: { planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true },
      critical: { planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true },
    };
  if (p === "/api/funding-sources") return [];
  if (p === "/api/companies/c1/projects") return [{ id: "p1", companyId: "c1", name: "Boss Man", starred: false }];
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
// A cold Chromium start plus three page loads took over the old 30 s test budget on GitHub's runners (BOS-1632),
// and each test paid the start again. One browser is started once, in beforeAll, with its own deadline; every
// test then only opens pages. LIMIT is for the slow machine: it still ends a hung page, and the layout
// assertions are unchanged, so a tab row or a broken menu column still fails.
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
// Wait until the Settings menu has drawn all its links (the event the old fixed sleeps stood in for).
async function menuReady(page: any, links = 16): Promise<void> {
  await page.waitForFunction((n: number) => document.querySelectorAll("nav[aria-label='Settings'] a").length >= n, links, { timeout: 15_000 });
}
async function launchChromium(): Promise<any | null> {
  let chromium: any;
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      /* try the next one */
    }
  }
  return null;
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

const sizes = [
  { name: "desktop", width: 1550, height: 1594, touch: false },
  { name: "foldable", width: fp.width, height: fp.units.vh, touch: fp.coarsePointer },
  { name: "phone", width: 380, height: 800, touch: true },
];

describe.skipIf(!built)("BOS-1019 Settings menu at the owner's sizes", () => {
  it("is a menu of links at every width, with the page marked, never a sideways tab row", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      for (const vp of sizes) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, hasTouch: vp.touch });
        const errors: string[] = [];
        page.on("pageerror", (e: any) => errors.push(String(e)));
        await page.goto(`${base}/#/settings/c1/reviews`);
        await menuReady(page);
        expect(JSON.stringify(errors), `${vp.name} page errors`).toBe("[]");
        const navHtml = await page.locator("nav[aria-label='Settings']").evaluate((el: Element) => el.outerHTML.slice(0, 400));
        // (BOS-1655: the one-row fold links for the other groups are not pages, so they are not counted.)
        expect(await page.locator("nav[aria-label='Settings'] a:not(.set-group-fold)").count(), `${vp.name}: 16 menu links ${navHtml}`).toBe(16);
        expect(await page.locator("[role='tablist']").count(), `${vp.name}: no tab row`).toBe(0);
        // The current page is marked, and shown by weight and a bar as well as colour.
        const cur = page.locator("nav[aria-label='Settings'] a[aria-current='page']");
        expect(await cur.count(), `${vp.name}: one current page`).toBe(1);
        expect(await cur.innerText()).toContain("Reviews");
        const weight = await cur.evaluate((el: Element) => getComputedStyle(el).fontWeight);
        expect(Number(weight), `${vp.name}: current is bold`).toBeGreaterThanOrEqual(600);
        const bar = await cur.evaluate((el: Element) => getComputedStyle(el).borderLeftWidth);
        expect(bar, `${vp.name}: current has a bar`).not.toBe("0px");
        // No sideways overflow of the menu.
        const overflow = await page.locator("nav[aria-label='Settings']").evaluate((el: Element) => el.scrollWidth - el.clientWidth);
        expect(overflow, `${vp.name}: menu does not scroll sideways`).toBeLessThanOrEqual(1);
        // Rows are big enough to press.
        // (Below 900 px a page has no menu; BOS-1224 checks that below.)
        if (vp.width >= 900) {
          const row = await page.locator("nav[aria-label='Settings'] a:not(.set-group-fold):visible").first().boundingBox();
          expect(row && row.height, `${vp.name}: rows are at least 40 px`).toBeGreaterThanOrEqual(vp.touch ? 44 : 40);
        }
        await saveShot(`settings-${vp.name}.png`, page);
        await saveShot(`settings-${vp.name}-full.png`, page, true);
        await page.close();
      }
    } finally {
      for (const ctx of browser.contexts()) await ctx.close(); // the shared browser itself closes in afterAll
    }
  }, LIMIT);

  it("has a 228 px menu column beside the page on a wide screen, and the menu alone on a phone", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      for (const vp of [sizes[0]!, sizes[1]!, sizes[2]!]) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, hasTouch: vp.touch });
        await page.goto(`${base}/#/settings/c1/reviews`);
        await menuReady(page);
        await page.waitForSelector(".set-page", { timeout: 15_000 });
        const nav = await page.locator("nav[aria-label='Settings']").boundingBox();
        const pageBox = await page.locator(".set-page").boundingBox();
        if (vp.width >= 900) {
          expect(Math.round(nav!.width), `${vp.name}: menu column is 228 px`).toBe(228);
          expect(nav!.x + nav!.width, `${vp.name}: page is beside the menu`).toBeLessThanOrEqual(pageBox!.x + 1);
          expect(nav!.y + nav!.height, `${vp.name}: the menu fits the screen`).toBeLessThanOrEqual(vp.height + 1);
        } else {
          // Below 900 px a page starts with "‹ Settings", and the menu column is gone.
          expect(await page.locator(".set-back").isVisible(), `${vp.name}: back link shows`).toBe(true);
          // BOS-1224: the whole menu is not drawn above the page, so the page starts near the top.
          expect(await page.locator("nav[aria-label='Settings']").isVisible(), `${vp.name}: no menu above a page`).toBe(false);
          expect(pageBox!.y, `${vp.name}: the page starts high`).toBeLessThan(400);
        }
        // The "All companies" tag stays on one line (Server and runner is a company-wide page).
        await page.goto(`${base}/#/settings/c1/updates`);
        await page.waitForSelector(".set-scope", { timeout: 15_000 });
        const tag = await page.locator(".set-scope").boundingBox();
        expect(tag!.height, `${vp.name}: tag is one line`).toBeLessThan(30);
        await saveShot(`system-${vp.name}.png`, page);
        await page.close();
      }
      // The phone's opening screen is the menu itself, each row with its hint.
      const phone = await browser.newPage({ viewport: { width: 380, height: 800 }, deviceScaleFactor: 1, hasTouch: true });
      await phone.goto(`${base}/#/settings`);
      await menuReady(phone);
      expect(await phone.locator("nav[aria-label='Settings'] a").count(), "phone menu: 16 rows").toBe(16);
      expect(await phone.locator("nav[aria-label='Settings'] .set-item-hint").first().isVisible(), "phone menu: hints show").toBe(true);
      expect(await phone.getByText("Run the setup wizard").count(), "phone menu: the wizard button").toBeGreaterThanOrEqual(1);
      expect(await phone.locator(".set-page").count(), "phone menu: no page shown yet").toBe(0);
      await saveShot("settings-phone-menu.png", phone);
      await phone.close();
    } finally {
      for (const ctx of browser.contexts()) await ctx.close(); // the shared browser itself closes in afterAll
    }
  }, LIMIT);

  it("BOS-1655: on a short window the other groups fold to one row each and the current group's pages all show; the old address marks Server and runner", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const f = sizes[1]!;
      const page = await browser.newPage({ viewport: { width: f.width, height: f.height }, deviceScaleFactor: 1, hasTouch: f.touch });
      await page.goto(`${base}/#/settings/c1/system`); // the old one-page address redirects to Updates
      await menuReady(page);
      await page.waitForFunction(() => location.hash.includes("/updates"), null, { timeout: 15_000 });
      const nav = page.locator("nav[aria-label='Settings']");
      const cur = page.locator(".set-group-current");
      expect(await cur.count(), "one current group").toBe(1);
      expect(await cur.locator(".set-group-label").innerText()).toMatch(/server and runner/i);
      expect(await cur.locator("a:visible").count(), "every page of the current group shows").toBe(await cur.locator("a").count());
      const folds = nav.locator("a.set-group-fold:visible");
      expect(await folds.count(), "the two other groups are one row each").toBe(2);
      expect(await nav.locator(".set-group-other ul").first().isVisible(), "folded group's pages are hidden").toBe(false);
      const box = await nav.boundingBox();
      expect(await nav.evaluate((el: Element) => el.scrollHeight - el.clientHeight), "side list needs no scrolling").toBeLessThanOrEqual(1);
      expect(box!.y + box!.height, "the side list fits the window").toBeLessThanOrEqual(f.height + 1);
      await saveShot("settings-fold-foldable.png", page);
      // Tapping a folded row opens that group's first page.
      await folds.first().click();
      await page.waitForFunction(() => !location.hash.includes("/updates"), null, { timeout: 15_000 });
      expect(await page.locator(".set-group-current").count(), "the tapped group is now current").toBe(1);
      expect(await nav.locator("a[aria-current='page']").count()).toBe(1);
      await page.close();
      // A tall window (desktop) is unchanged: no fold rows show.
      const d = sizes[0]!;
      const tall = await browser.newPage({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: 1 });
      await tall.goto(`${base}/#/settings/c1/updates`);
      await menuReady(tall);
      expect(await tall.locator("a.set-group-fold:visible").count(), "no folds on a tall window").toBe(0);
      await saveShot("settings-fold-desktop-tall.png", tall);
      await tall.close();
    } finally {
      for (const ctx of browser.contexts()) await ctx.close();
    }
  }, LIMIT);

  it("BOS-1126 Q8: the bare menu on a wide screen shows each hint under its name in three group columns, one column on a phone", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      for (const vp of [sizes[0]!, sizes[1]!]) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, hasTouch: vp.touch });
        await page.goto(`${base}/#/settings`);
        await menuReady(page);
        const hint = page.locator("nav[aria-label='Settings'] .set-item-hint").first();
        expect(await hint.isVisible(), `${vp.name}: hint shows`).toBe(true);
        // BOS-1492: from 1200 px the 14 pages are three groups side by side (one column each), so the first page
        // of the second group sits to the right of the first page of the first group, on the same row.
        const links = page.locator("nav[aria-label='Settings'] ul").locator("a");
        const lists = page.locator("nav[aria-label='Settings'] ul");
        expect(await lists.count(), `${vp.name}: three groups`).toBe(3);
        const a = await lists.nth(0).locator("a").first().boundingBox();
        const b = await lists.nth(1).locator("a").first().boundingBox();
        const c = await lists.nth(2).locator("a").first().boundingBox();
        expect(await links.count(), `${vp.name}: all 16 pages are in the menu`).toBe(16);
        expect(b!.x, `${vp.name}: second group sits in a second column`).toBeGreaterThan(a!.x + a!.width - 1);
        expect(c!.x, `${vp.name}: third group sits in a third column`).toBeGreaterThan(b!.x + b!.width - 1);
        expect(Math.abs(b!.y - a!.y), `${vp.name}: same row`).toBeLessThan(2);
        // Within a group the pages stack in one column.
        const a2 = await lists.nth(0).locator("a").nth(1).boundingBox();
        expect(a2!.y, `${vp.name}: a group's pages are one column`).toBeGreaterThan(a!.y + a!.height - 1);
        const rowGap = await page.locator("nav[aria-label='Settings'] ul").first().evaluate((el: Element) => getComputedStyle(el).rowGap);
        expect(rowGap, `${vp.name}: the rows sit on the 8 px spacing scale`).toBe("8px");
        await saveShot(`settings-index-${vp.name}.png`, page);
        await page.close();
      }
      const phone = await browser.newPage({ viewport: { width: 380, height: 800 }, deviceScaleFactor: 1, hasTouch: true });
      await phone.goto(`${base}/#/settings`);
      await menuReady(phone);
      const l = phone.locator("nav[aria-label='Settings'] ul").first().locator("a");
      const p0 = await l.nth(0).boundingBox();
      const p1 = await l.nth(1).boundingBox();
      expect(p1!.y, "phone: one column, the second page is below the first").toBeGreaterThan(p0!.y + p0!.height - 1);
      await phone.close();
    } finally {
      for (const ctx of browser.contexts()) await ctx.close(); // the shared browser itself closes in afterAll
    }
  }, LIMIT);
});
