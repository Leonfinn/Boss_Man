// QA walk of the redesigned Settings (BOS-1020, from BOS-1018's old → new map): every section the owner had
// before is on the page the map says, with no page error, at the desktop, foldable and phone sizes; and the
// old addresses really land on the new page in the browser (not just in the redirect table).
// Runs the real built web app in Chromium against canned answers. Skipped where the build or a browser is missing.
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WATCHDOG } from "@boss-man/shared";
import { urlStub } from "./stub-fetch";

const DIST = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "dist");
const built = existsSync(path.join(DIST, "index.html"));
const now = () => new Date().toISOString();
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOSS", nextTicketNumber: 12, agents: [], projects: [] };

const fundingSource = { id: "f1", name: "Claude Max", kind: "subscription", provider: "anthropic", monthlyGrantMicros: null, cycleAnchor: null };

const lvl = { planApprover: "ceo", reviewer: "ceo", ownerSignoff: false };
const opinionWindow = { answered: 0, allowed: 0, denied: 0, fellBack: 0, pending: 0, reasons: [], bothVerdicts: 0, agreed: 0, agreement: null, perDay: [] };
const unset = { set: false, hint: null, secretName: null };
// Every request the walked pages make, by path (BOS-2451). There is no "anything else" answer: a page that gains a
// request fails here with "no stub for GET /api/…" instead of reading a wrong shape and erroring only on GitHub.
const api = urlStub({
  "/api/setup": { needsSetup: false },
  "/api/me": { username: "owner" },
  "/api/setup-progress": { dismissed: true },
  "/api/companies": [company],
  "/api/notifications": { items: [], unread: 0 },
  "/api/notifications/unseen": { count: 0 },
  "/api/funding-sources": [fundingSource],
  "/api/funding-sources/f1/status": { source: fundingSource, credit: null, quota: [{ window: "five_hour", utilization: 0.42, resetsAt: null, status: null }], windowsSeen: ["five_hour"], forecasts: {}, daily: [], totalSpentMicros: 0, coverage: "all" },
  "/api/budgets": [{ policy: { id: "b1", scopeKind: "instance", scopeId: "x", windowKind: "calendar_month", limitMicros: 5_000_000, onLimit: "pause" }, status: { usedMicros: 1_000_000, limitMicros: 5_000_000, fractionUsed: 0.2, state: "ok" } }],
  "/api/runs": [],
  "/api/decisions": [],
  "/api/decisions/advised": [],
  "/api/decisions/with-team": [],
  "/api/decisions/closed-notices": [],
  "/api/devices": [],
  "/api/health": () => ({ role: "leader", version: "1.2.0", commit: "aaaaaaaaaaaa", colour: null, startedAt: now() }),
  "/api/bluegreen": { enabled: false },
  "/api/kill-switch": { paused: false },
  "/api/maintenance": { on: false, last: null },
  "/api/maintenance/history": { holds: [] },
  "/api/runner-report": { live: [], update: null },
  "/api/release-watch": { active: false },
  "/api/self-deploy": { enabled: true, status: null, available: null },
  "/api/run-limits": { instance: 8, company: 4, background: 2, defaults: { instance: 8, company: 4, background: 2 } },
  "/api/settings/check-queue": { mode: "legacy", slots: 1, maxSlots: 4, defaultSlots: 1, runnersTooOld: [] },
  "/api/private-details": { total: 0, counts: {} },
  // The Network guard section only shows once a runner has reported (the panel hides itself with no report), so the walk gives it one.
  "/api/netguard-allow": () => ({ report: { mode: "on", entries: [], lineCanGo: false, automatic: [], env: { lines: [], reportedAt: now(), envFound: true }, warnings: [] } }),
  "/api/host-facts": () => ({ hostName: "host", reportedAt: now(), ownerFacts: [], facts: {} }),
  "/api/companies/c1/projects": [{ id: "p1", companyId: "c1", name: "Boss Man", starred: false }],
  "/api/policy-rules": { company: [], global: [], defaults: [], shadowedIds: [] },
  "/api/companies/c1/watchdog": { settings: DEFAULT_WATCHDOG, scrumMaster: null, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0 },
  "/api/projects/*": () => ({ monthMicros: 0, totalMicros: 0, ticketCostCapMicros: null, monthlyCapMicros: null, monthStart: now(), topTickets: [] }),
  "/api/companies/c1/review-policy": { trivial: lvl, low: lvl, medium: lvl, high: { ...lvl, ownerSignoff: true }, critical: { ...lvl, ownerSignoff: true } },
  // The app shell's own polls, on every page.
  "/api/feedback/unprocessed": {},
  "/api/companies/c1/merge-queue": { waitingCount: 0, lineCount: 0, stuckCount: 0 },
  "/api/decisions/tally": { open: 0, waiting: 0 },
  // Team.
  "/api/companies/c1/standing-rules": { text: "", by: null, at: null, max: 4000 },
  "/api/companies/c1/chapters": [],
  "/api/companies/c1/agent-approvals": { approvals: "hires" },
  "/api/companies/c1/retro-settings": { agentId: null, runner: null, last: null, doneSince: 0, history: [] },
  // Permissions.
  "/api/policy-rules/usage": { rules: {} },
  "/api/policy-rules/most-asked": { cards: [] },
  "/api/companies/c1/second-opinion": { enabled: false, baseUrl: "", model: "", secretId: null },
  "/api/companies/c1/second-opinion/stats": { last24h: opinionWindow, last7d: opinionWindow, last30d: opinionWindow },
  "/api/companies/c1/runner": { registered: false },
  // Funding, Tools, Updates, Limits, Email, This host, Server.
  "/api/secrets": [],
  "/api/companies/c1/mcp-servers": [],
  "/api/companies/c1/deploy-targets": [],
  "/api/companies/c1/penpot": { configured: false, url: null, urlHint: null, guardAddress: null, guardTrustsPrivate: false, token: unset, email: unset, password: unset, agentIds: [], exportAgentIds: [] },
  "/api/self-deploy/wait": { on: false },
  "/api/self-deploy/history": [],
  "/api/wip-limits": { agent: null, company: null, defaultAgent: 2 },
  "/api/settings/check-workers/stats": [],
  "/api/settings/check-workers/line": { days: [], kinds: [], busiestHours: [], waitingNow: 0, oldestWaitSeconds: null, timeZone: "UTC" },
  "/api/settings/wait-for-ci": { on: false },
  "/api/settings/merge-carry": { on: false, turnMinutes: 30 },
  "/api/settings/main-ci": { on: false, projects: [] },
  "/api/settings/email": { settings: null, configured: false },
  "/api/daily-backup": { lastAt: null, failed: null, stale: false },
  "/api/data-health": { disk: null, database: { bytes: null, dayAgoBytes: null, weekAgoBytes: null, growthPercent7d: null }, limits: { statementTimeouts: 0, poolFull: 0 }, slowQueries: [], warnings: [] },
});

let server: Server | undefined;
let base = "";
const mime = (f: string) => (f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".html") ? "text/html" : "application/octet-stream");
beforeAll(async () => {
  server = createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (p.startsWith("/api/")) {
      const a = api.answer(req.url ?? "/", { method: req.method });
      res.writeHead(a.found ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(a.found ? a.body : { error: `no stub for ${req.method} ${p}` }));
      return;
    }
    const file = path.join(DIST, p === "/" ? "index.html" : p);
    const use = existsSync(file) && !file.endsWith(path.sep) ? file : path.join(DIST, "index.html");
    res.writeHead(200, { "content-type": mime(use) });
    createReadStream(use).pipe(res);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const a = server!.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function launch(): Promise<any | null> {
  let chromium: any;
  try {
    const req = createRequire(import.meta.url);
    try {
      chromium = req("playwright").chromium;
    } catch {
      chromium = req("playwright-core").chromium;
    }
  } catch {
    console.warn("settings-walk: playwright is not installed; the browser walk was skipped");
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    } catch (e) {
      console.warn(`settings-walk: launch ${executablePath ?? "bundled"} failed: ${String(e).slice(0, 300)}`);
    }
  }
  console.warn("settings-walk: no Chromium could be launched; the browser walk was skipped");
  return null;
}

/** Wait for a smooth scroll to come to rest, then report where the target is: "ok", "missing", or "off screen
 *  (top N)". It waits, with a deadline, until the scroll position and the page's drawn height have both held still
 *  for a moment: a section that loads its own answer ("Loading…" first) grows the page after the click, which can
 *  leave the jump short (BOS-1319). No fixed sleep; the hold is what tells "still scrolling" from "at rest". */
async function settleScroll(page: any, target: string, timeout = 10_000, holdMs = 300): Promise<string> {
  await page
    .waitForFunction(
      (hold: number) => {
        const w = window as unknown as { __s?: { y: number; h: number; since: number } };
        const y = window.scrollY;
        const h = document.documentElement.scrollHeight;
        const t = Date.now();
        if (!w.__s || w.__s.y !== y || w.__s.h !== h) w.__s = { y, h, since: t };
        return t - w.__s.since >= hold;
      },
      holdMs,
      { timeout, polling: 100 },
    )
    .catch(() => undefined);
  return sectionPlacement(page, target);
}

/** Where the target is in the window: "ok" when part of it shows, else "missing" or "off screen (top N)". Visible
 *  means the window's real height (the visual viewport when the browser draws one, as on a phone), not
 *  window.innerHeight. */
function sectionPlacement(page: any, target: string): Promise<string> {
  return page.evaluate((t: string) => {
    const el = document.getElementById(t);
    if (!el) return "missing";
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const seenTop = vv?.offsetTop ?? 0;
    const seenBottom = seenTop + (vv?.height ?? window.innerHeight);
    return Math.min(r.bottom, seenBottom) > Math.max(r.top, seenTop) ? "ok" : `off screen (top ${Math.round(r.top)})`;
  }, target);
}

/** Whether there is any page left below the window: when there is none, a click cannot move a section up any more,
 *  so the walk stops retrying and the assertion says where the section is (BOS-1336). */
function canScrollFurther(page: any): Promise<boolean> {
  return page.evaluate(() => window.scrollY < document.documentElement.scrollHeight - window.innerHeight - 2);
}

/** Each page and the section headings the old → new map puts on it (headings as the app shows them). */
const MAP: Record<string, string[]> = {
  funding: ["Funding sources", "Budgets"],
  tools: ["Tool servers (MCP)", "Deploy targets"],
  reviews: ["Reviews", "Did it move the goal?"],
  team: ["Standing rules", "CEO chapters", "Asking the CEO for advice", "Nudges", "Run time limit", "Workflow retros", "Ticket references"],
  watchdog: ["Watchdog"],
  permissions: ["Advice on permission cards", "Second opinion from a model (optional)", "Agent fence"],
  // "Server and runner" is six pages (BOS-1492); each of its old panels is on the page the BOS-1491 table gives it.
  updates: ["Updates", "Stop all work"],
  limits: ["Agents at once", "Tickets in progress", "Checks"],
  runner: ["Runner", "Workspace disk"],
  email: ["Outgoing email"],
  server: ["Server", "This host", "Network guard"],
  devices: ["Your devices", "Private details to block"],
  transfer: ["Import a company"],
};
const SIZES = [
  { name: "desktop", width: 1550, height: 1594, touch: false },
  { name: "foldable", width: 1667, height: 724, touch: true },
  { name: "phone", width: 380, height: 800, touch: true },
];

describe.skipIf(!built)("BOS-1020 every old setting is on its new Settings page", () => {
  // One test per size (BOS-1708): the three sizes walked in one test shared a single 90 s budget, which GitHub's
  // slower runners overran; each size now has its own, and the walk waits for each page's events, not a sleep.
  for (const vp of SIZES) it(`shows each mapped section, with no page error, at ${vp.name}`, async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });
        const errors: string[] = [];
        const wide: string[] = [];
        page.on("pageerror", (e: any) => errors.push(String(e)));
        for (const [id, headings] of Object.entries(MAP)) {
          await page.goto(`${base}/#/settings/c1/${id}`);
          await page.waitForSelector(".set-page h2", { timeout: 8000 }).catch(async (e: any) => {
            throw new Error(`${vp.name}: ${id} shows no section: ${String(e).slice(0, 80)}; page says ${JSON.stringify((await page.locator("body").innerText()).slice(-300))}`);
          });
          // Wait for the mapped headings to show (a section that loads its own answer draws them late), with a
          // deadline; a miss falls through to the assertion below, which names what was found.
          await page
            .waitForFunction(
              (hs: string[]) => {
                const texts = [...document.querySelectorAll(".set-page h2, .set-page h3")].map((e) => (e.textContent ?? "").trim());
                return hs.every((h) => texts.some((f) => f === h || f.startsWith(h)));
              },
              headings,
              { timeout: 10_000, polling: 100 },
            )
            .catch(() => undefined);
          if (id === "funding") {
            await page.waitForSelector(".set-page .source-card", { timeout: 10_000 }).catch(() => undefined);
            await page.waitForSelector(".set-page table", { timeout: 10_000 }).catch(() => undefined);
          }
          const found = (await page.locator(".set-page h2, .set-page h3").allInnerTexts()).map((t: string) => t.trim());
          for (const h of headings) {
            expect(found.some((f: string) => f === h || f.startsWith(h)), `${vp.name}: "${h}" on ${id}; found ${JSON.stringify(found)}; errors ${JSON.stringify(errors)}; body ${JSON.stringify((await page.locator("main, body").first().innerText()).split("TypeError")[1]?.slice(0, 200))}`).toBe(true);
          }
          // BOS-1053: headings alone missed the Funding page losing its status cards and the budget-policy table.
          if (id === "funding") {
            expect(await page.locator(".set-page .source-card").count(), `${vp.name}: a status card per funding source on funding`).toBe(1);
            expect(await page.locator(".set-page table").count(), `${vp.name}: the budget-policy table on funding`).toBeGreaterThan(0);
            expect(found, `${vp.name}: Spending limits on funding`).toContain("Spending limits");
          }
          // No page sideways-scrolls (a phone with a wide table would).
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (over > 1) wide.push(`${vp.name}/${id} +${over}px`);
          expect(api.takeMisses(), `${vp.name}/${id}: requests with no stub`).toEqual([]);
        }
        expect(wide, "pages that scroll sideways").toEqual([]);
        expect(JSON.stringify(errors), `${vp.name} page errors`).toBe("[]");
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 90_000);

  // BOS-1063: a plain "#id" link replaced the route and sent the owner to the dashboard.
  // One test per size (BOS-1708), for the same reason as the walk above.
  for (const vp of SIZES) it(`every 'On this page' link keeps the route and brings its own section into view at ${vp.name}`, async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });
        for (const id of ["team", "permissions"]) {
          // A hash change keeps the old page's links on screen for a moment, which the wait below would take for
          // the new page's; a blank page in between gives each id a clean start.
          await page.goto("about:blank");
          await page.goto(`${base}/#/settings/c1/${id}`);
          // The links can draw, vanish and draw again while the section loads its answer, so "more than 3 links"
          // must hold for a moment before they are read (the old 500 ms sleep stood in for this hold). The wait
          // also returns the links it saw holding, rather than reading them again after it: a separate read is a
          // later round-trip, and a section reloading its answer in between could empty the list and be read as 0.
          const held = await page
            .waitForFunction(
              () => {
                const w = window as any;
                const links = Array.from(document.querySelectorAll(".set-jump a")).map((a) => (a.getAttribute("href") || "").slice(1));
                if (links.length <= 3) {
                  w.__jumpSince = 0;
                  return false;
                }
                w.__jumpSince = w.__jumpSince || Date.now();
                return Date.now() - w.__jumpSince >= 400 ? links : false;
              },
              undefined,
              { timeout: 10_000, polling: 100 },
            )
            .catch(() => undefined);
          const hrefs: string[] = held ? ((await held.jsonValue()) as string[]) : [];
          // If the hold never held, say what the page actually showed (its jump links and headings), so the next
          // bounce tells whether the page was still drawing or the section ids were missing.
          const seen =
            hrefs.length > 3
              ? ""
              : `; saw links ${JSON.stringify(await page.locator(".set-jump a").evaluateAll((as: any[]) => as.map((a) => a.getAttribute("href"))))}, headings ${JSON.stringify(await page.locator(".set-page h2, .set-page h3").allInnerTexts())}`;
          expect(hrefs.length, `${vp.name}/${id} has jump links${seen}`).toBeGreaterThan(3);
          for (const target of hrefs) {
            // Bring the section into view and confirm it settles there (BOS-1319/BOS-1336). A single click + "is it
            // in view once" is not enough: the page can still be growing (a section above shows "Loading…" until
            // its own answer arrives), so the smooth scroll may be aimed at a shorter layout and the section drifts
            // off screen afterwards. Wait for the scroll and page height to settle, and if the section is not in
            // view after that, click its jump link again (what a reader would do) — retrying until a deadline.
            // The same wait runs for every section on every page at every size, so no section name has its own
            // treatment and none can flake on its own.
            const link = page.locator(`.set-jump a[href="#${target}"]`);
            const deadline = Date.now() + 10_000;
            let inView = "missing";
            for (;;) {
              await link.click();
              await page
                .waitForFunction(
                  (t: string) => {
                    const el = document.getElementById(t);
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    return r.bottom > 0 && r.top < window.innerHeight;
                  },
                  target,
                  { timeout: 5_000, polling: 50 },
                )
                .catch(() => undefined);
              inView = await settleScroll(page, target);
              // Clicking again cannot bring a section any higher once the browser is at the end of the page, so a
              // miss there is answered by the assertion below (with where the section actually is), not a retry.
              if (inView === "ok" || Date.now() >= deadline || !(await canScrollFurther(page))) break;
            }
            expect(await page.evaluate(() => location.hash), `${vp.name}/${id}: route after ${target}`).toBe(`#/settings/c1/${id}`);
            expect(inView, `${vp.name}/${id}: section ${target}`).toBe("ok");
          }
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 180_000);

  async function landsOn(pairs: ReadonlyArray<readonly [string, string]>) {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1550, height: 1000 } });
      for (const [from, to] of pairs) {
        await page.goto(`${base}/#/${from}`);
        await page.waitForFunction((t: string) => location.hash === `#/${t}`, to, { timeout: 4000 }).catch(() => undefined);
        expect(await page.evaluate(() => location.hash), `${from} lands on ${to}`).toBe(`#/${to}`);
      }
      await page.close();
    } finally {
      await browser.close();
    }
  }

  it("lands old addresses that carry a company on the new page in the real app", async () => {
    await landsOn([
      ["settings/c1/access", "settings/c1/tools"],
      ["settings/c1/workflow", "settings/c1/reviews"],
      ["rules/c1", "settings/c1/permissions"],
      ["settings/c1/gone", "settings"],
      // BOS-1492: the one-page "Server and runner" opens Updates, the first of its six pages.
      ["settings/c1/system", "settings/c1/updates"],
    ]);
  }, 60_000);

  it("lands the old bare #/funding and #/secrets on Funding and Secrets", async () => {
    await landsOn([
      ["funding", "settings/c1/funding"],
      ["secrets", "settings/c1/secrets"],
    ]);
  }, 60_000);
});
