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
afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function launch(): Promise<any | null> {
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
        await page.waitForSelector("nav[aria-label='Settings']", { timeout: 8000 });
        await new Promise((r) => setTimeout(r, 400));
        expect(JSON.stringify(errors), `${vp.name} page errors`).toBe("[]");
        const navHtml = await page.locator("nav[aria-label='Settings']").evaluate((el: Element) => el.outerHTML.slice(0, 400));
        expect(await page.locator("nav[aria-label='Settings'] a").count(), `${vp.name}: nine menu links ${navHtml}`).toBe(9);
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
        const row = await page.locator("nav[aria-label='Settings'] a").first().boundingBox();
        expect(row && row.height, `${vp.name}: rows are at least 40 px`).toBeGreaterThanOrEqual(vp.touch || vp.width < 900 ? 44 : 40);
        await saveShot(`settings-${vp.name}.png`, page);
        await saveShot(`settings-${vp.name}-full.png`, page, true);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("has a 228 px menu column beside the page on a wide screen, and the menu alone on a phone", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      for (const vp of [sizes[0]!, sizes[1]!, sizes[2]!]) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, hasTouch: vp.touch });
        await page.goto(`${base}/#/settings/c1/reviews`);
        await page.waitForSelector("nav[aria-label='Settings']", { timeout: 8000 });
        await new Promise((r) => setTimeout(r, 300));
        const nav = await page.locator("nav[aria-label='Settings']").boundingBox();
        const pageBox = await page.locator(".set-page").boundingBox();
        if (vp.width >= 900) {
          expect(Math.round(nav!.width), `${vp.name}: menu column is 228 px`).toBe(228);
          expect(nav!.x + nav!.width, `${vp.name}: page is beside the menu`).toBeLessThanOrEqual(pageBox!.x + 1);
          expect(nav!.y + nav!.height, `${vp.name}: the menu fits the screen`).toBeLessThanOrEqual(vp.height + 1);
        } else {
          // Below 900 px a page starts with "‹ Settings", and the menu column is gone.
          expect(await page.locator(".set-back").isVisible(), `${vp.name}: back link shows`).toBe(true);
        }
        await page.close();
      }
      // The phone's opening screen is the menu itself, each row with its hint.
      const phone = await browser.newPage({ viewport: { width: 380, height: 800 }, deviceScaleFactor: 1, hasTouch: true });
      await phone.goto(`${base}/#/settings`);
      await phone.waitForSelector("nav[aria-label='Settings']", { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 300));
      expect(await phone.locator("nav[aria-label='Settings'] a").count(), "phone menu: nine rows").toBe(9);
      expect(await phone.locator("nav[aria-label='Settings'] .set-item-hint").first().isVisible(), "phone menu: hints show").toBe(true);
      expect(await phone.getByText("Run the setup wizard").count(), "phone menu: the wizard button").toBeGreaterThanOrEqual(1);
      expect(await phone.locator(".set-page").count(), "phone menu: no page shown yet").toBe(0);
      await saveShot("settings-phone-menu.png", phone);
      await phone.close();
    } finally {
      await browser.close();
    }
  });
});
