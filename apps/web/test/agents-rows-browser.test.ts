// @vitest-environment node
// A rendering check for the Agents rows (BOS-1256): the built web app is served from `apps/web/dist` to
// Chromium with made-up agents, at the owner's three sizes (Brave 1667×724 touch, Safari 1550×1611, phone 390).
// It measures what jsdom cannot: no sideways scroll, the ⋯ menu pinned to the bottom on a phone with rows of
// at least 44 px, and the contrast of the status colours on the card, in the dark theme the app ships.
// Skipped, not failed, where the build or a browser is missing. Screenshots go to BOSSMAN_SCRATCH.
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIST = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "dist");
const built = existsSync(path.join(DIST, "index.html"));

const now = () => new Date().toISOString();
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", nextTicketNumber: 12, agents: [], projects: [] };
const agent = { companyId: "c1", role: "worker", agentKind: "claude", model: "opus", fundingSourceId: null, paused: false, starred: false, duty: "Builds the pages and keeps them tidy", instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 123456789, runs: 12, tokens: 4000 } };
const agents = [
  { ...agent, id: "a1", name: "Bramble the Very Long Named Web Developer", title: "Web Developer (Boss Man web app)", status: "working", current: "BOS-1256 Agents rows: one Pause button", wipCount: 4, wipLimit: 3 },
  { ...agent, id: "a2", name: "Moss", title: "Reviewer", paused: true, status: "paused" },
  { ...agent, id: "a3", name: "Boss", role: "ceo", title: "CEO" },
  { ...agent, id: "a4", name: "Old", title: "Retired one", retiredAt: "2026-11-01T00:00:00Z", status: "retired" },
];

function answer(p: string): unknown {
  if (p === "/api/setup") return { needsSetup: false };
  if (p === "/api/me") return { username: "owner" };
  if (p === "/api/setup-progress") return { dismissed: true };
  if (p === "/api/companies") return [company];
  if (p === "/api/notifications") return { items: [], unread: 0 };
  if (p === "/api/notifications/unseen") return { count: 0 };
  if (["/api/runs", "/api/decisions", "/api/decisions/advised", "/api/decisions/with-team", "/api/decisions/closed-notices", "/api/devices", "/api/funding-sources", "/api/agent-templates"].includes(p)) return p === "/api/agent-templates" ? { templates: [] } : [];
  if (p === "/api/health") return { role: "leader", version: "1.2.0", commit: "aaaaaaaaaaaa", colour: null, startedAt: now() };
  if (p === "/api/bluegreen" || p === "/api/self-deploy") return { enabled: false };
  if (p === "/api/kill-switch") return { paused: false };
  if (p === "/api/maintenance") return { on: false, last: null };
  if (p === "/api/runner-report") return { live: [], update: null };
  if (p === "/api/companies/c1/agents") return agents;
  if (p === "/api/companies/c1/projects") return [];
  if (p === "/api/companies/c1/models") return { runner: {}, api: [] };
  if (p.startsWith("/api/decisions/tally")) return { open: 0, waiting: 0 };
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
      return await chromium.launch(executablePath ? { executablePath, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const shots = process.env.BOSSMAN_SCRATCH;
const saveShot = async (name: string, page: any) => {
  if (!shots) return;
  try {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, name) });
  } catch {
    /* a screenshot is not the test */
  }
};

/** In the page: WCAG contrast of an element's text colour on the first opaque background above it. */
function contrastOf(sel: string) {
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
  };
  const parse = (v: string): number[] | null => {
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return p.length >= 4 && p[3] === 0 ? null : [p[0]!, p[1]!, p[2]!];
  };
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) return { found: false, ratio: 0 };
  const text = parse(getComputedStyle(el).color)!;
  // Soft pills paint their own tint over the card; walk up to the first opaque layer (the card).
  let bg: number[] | null = null;
  for (let n: HTMLElement | null = el; !bg && n; n = n.parentElement) bg = parse(getComputedStyle(n).backgroundColor);
  const [hi, lo] = lum(text) > lum(bg!) ? [lum(text), lum(bg!)] : [lum(bg!), lum(text)];
  return { found: true, ratio: (hi + 0.05) / (lo + 0.05) };
}

const SIZES = [
  { name: "brave-1667x724", width: 1667, height: 724, touch: true },
  { name: "safari-1550x1611", width: 1550, height: 1611, touch: false },
  { name: "phone-390", width: 390, height: 844, touch: true },
];

describe.skipIf(!built)("BOS-1256 Agents rows in a real browser", () => {
  for (const s of SIZES) {
    it(`${s.name}: no sideways scroll, menu works, statuses legible`, async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, hasTouch: s.touch, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        await page.goto(`${base}/#/agents/c1`, { waitUntil: "networkidle" });
        await page.waitForSelector(".agent-card .agent-name", { timeout: 15_000 }).catch(async (e: Error) => {
          await saveShot(`bos-1256-failed-${s.name}.png`, page);
          throw new Error(`${e.message}\nPage text: ${(await page.evaluate(() => document.body.innerText)).slice(0, 400)}`);
        });
        const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        expect(overflow.sw, `page scroll width ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.cw);
        // Every card stays inside the window, long name and all.
        const cardsFit = await page.evaluate(() => [...document.querySelectorAll(".agent-card")].every((c) => c.getBoundingClientRect().right <= window.innerWidth + 1 && c.scrollWidth <= c.clientWidth + 1));
        expect(cardsFit, "cards fit the window").toBe(true);
        await saveShot(`bos-1256-after-${s.name}.png`, page);

        // Status colours read on the card (4.5:1).
        for (const sel of [".pill.working", ".pill.paused", ".pill.idle", ".over-limit"]) {
          const c = await page.evaluate(contrastOf, sel);
          if (c.found) expect(c.ratio, `${sel} contrast`).toBeGreaterThanOrEqual(4.5);
        }

        await page.getByRole("button", { name: "More for Bramble the Very Long Named Web Developer" }).click();
        await page.waitForSelector("[role=menu] [role=menuitem]");
        const items = await page.evaluate(() => [...document.querySelectorAll(".row-menu-item")].map((e) => Math.round(e.getBoundingClientRect().height)));
        expect(items.length).toBeGreaterThanOrEqual(3);
        const list = await page.evaluate(() => {
          const r = document.querySelector(".row-menu-list")!.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: window.innerHeight, vw: window.innerWidth };
        });
        expect(list.left, "menu inside the window").toBeGreaterThanOrEqual(0);
        expect(list.right, "menu inside the window").toBeLessThanOrEqual(list.vw + 1);
        if (s.width < 641) {
          expect(Math.abs(list.bottom - list.vh), "phone menu is pinned to the bottom").toBeLessThanOrEqual(1);
          for (const h of items) expect(h, "phone menu rows are at least 44px").toBeGreaterThanOrEqual(44);
          // Tapping the dimmed page closes the menu and leaves the edit panel shut.
          await page.mouse.click(10, 10);
          await page.waitForSelector("[role=menu]", { state: "detached" });
          const expanded = await page.getByRole("button", { name: "Bramble the Very Long Named Web Developer", exact: true }).getAttribute("aria-expanded");
          expect(expanded).toBe("false");
        } else {
          for (const h of items) expect(h, "desktop menu rows are at least 40px").toBeGreaterThanOrEqual(40);
        }
        await ctx.close();
      } finally {
        await browser.close();
      }
    }, 60_000);
  }
});
