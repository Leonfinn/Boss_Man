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

const DIST = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "dist");
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
  if (["/api/runs", "/api/decisions", "/api/decisions/advised", "/api/decisions/with-team", "/api/decisions/closed-notices", "/api/devices", "/api/funding-sources"].includes(p)) return [];
  if (p === "/api/health") return { role: "leader", version: "1.2.0", commit: "aaaaaaaaaaaa", colour: null, startedAt: now() };
  if (p === "/api/bluegreen") return { enabled: false };
  if (p === "/api/kill-switch") return { paused: false };
  if (p === "/api/maintenance") return { on: false, last: null };
  if (p === "/api/runner-report") return { live: [], update: null };
  if (p === "/api/self-deploy") return { enabled: false };
  if (p === "/api/run-limits") return { instance: 8, company: 4, background: 2, defaults: { instance: 8, company: 4, background: 2 } };
  if (p === "/api/settings/check-queue") return { mode: "legacy", slots: 1, maxSlots: 4, defaultSlots: 1, runnersTooOld: [] };
  if (p === "/api/netguard-allow") return { report: null };
  if (p === "/api/host-facts") return { hostName: "host", reportedAt: now(), ownerFacts: [], facts: {} };
  if (p === "/api/companies/c1/projects") return [{ id: "p1", companyId: "c1", name: "Boss Man", starred: false }];
  if (p === "/api/policy-rules") return { company: [], global: [], defaults: [], shadowedIds: [] };
  if (p === "/api/companies/c1/watchdog") return { settings: DEFAULT_WATCHDOG, scrumMaster: null, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0 };
  if (p.startsWith("/api/projects/")) return { monthMicros: 0, totalMicros: 0, ticketCostCapMicros: null, monthlyCapMicros: null, monthStart: now(), topTickets: [] };
  if (p === "/api/companies/c1/review-policy") {
    const lvl = { planApprover: "ceo", reviewer: "ceo", ownerSignoff: false };
    return { trivial: lvl, low: lvl, medium: lvl, high: { ...lvl, ownerSignoff: true }, critical: { ...lvl, ownerSignoff: true } };
  }
  // Anything else: an empty list, which survives both `.find(...)` and `.field` reads where `{}` would not.
  return [];
}

let server: Server | undefined;
let base = "";
const mime = (f: string) => (f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".html") ? "text/html" : "application/octet-stream");
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
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      /* next */
    }
  }
  return null;
}

/** Each page and the section headings the old → new map puts on it (headings as the app shows them). */
const MAP: Record<string, string[]> = {
  funding: ["Funding sources", "Budgets"],
  tools: ["Tool servers (MCP)", "Deploy targets"],
  reviews: ["Reviews", "Did it move the goal?"],
  team: ["Standing rules", "CEO chapters", "Asking the CEO for advice", "Nudges", "Run time limit", "Workflow retros", "Ticket references"],
  watchdog: ["Watchdog"],
  permissions: ["Advice on permission cards", "Second opinion from a model (optional)", "Agent fence"],
  system: ["Stop all work", "Runner update", "Runner", "Workspace disk", "How many agents run at once", "Tickets in progress", "Checks", "Server", "This host", "Your devices"],
  transfer: ["Import a company"],
};
const SIZES = [
  { name: "desktop", width: 1550, height: 1594, touch: false },
  { name: "foldable", width: 1667, height: 724, touch: true },
  { name: "phone", width: 380, height: 800, touch: true },
];

describe.skipIf(!built)("BOS-1020 every old setting is on its new Settings page", () => {
  it("shows each mapped section, with no page error, at desktop, foldable and phone sizes", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      for (const vp of SIZES) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });
        const errors: string[] = [];
        const wide: string[] = [];
        page.on("pageerror", (e: any) => errors.push(String(e)));
        for (const [id, headings] of Object.entries(MAP)) {
          await page.goto(`${base}/#/settings/c1/${id}`);
          await page.waitForSelector(".set-page h2", { timeout: 8000 }).catch(async (e: any) => {
            throw new Error(`${vp.name}: ${id} shows no section: ${String(e).slice(0, 80)}; page says ${JSON.stringify((await page.locator("body").innerText()).slice(-300))}`);
          });
          await new Promise((r) => setTimeout(r, 500));
          const found = (await page.locator(".set-page h2, .set-page h3").allInnerTexts()).map((t: string) => t.trim());
          for (const h of headings) {
            expect(found.some((f: string) => f === h || f.startsWith(h)), `${vp.name}: "${h}" on ${id}; found ${JSON.stringify(found)}; errors ${JSON.stringify(errors)}; body ${JSON.stringify((await page.locator("main, body").first().innerText()).split("TypeError")[1]?.slice(0, 200))}`).toBe(true);
          }
          // No page sideways-scrolls (a phone with a wide table would).
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (over > 1) wide.push(`${vp.name}/${id} +${over}px`);
        }
        // KNOWN (BOS-1020 finding): at 380 px the Watchdog (+226 px) and Permissions (+146 px) pages scroll sideways.
        // Drop these two from KNOWN_WIDE when they are fixed, so the walk guards them too.
        const KNOWN_WIDE = ["phone/watchdog", "phone/permissions"];
        expect(wide.filter((w) => !KNOWN_WIDE.some((k) => w.startsWith(`${k} `))), "pages that scroll sideways").toEqual([]);
        expect(JSON.stringify(errors), `${vp.name} page errors`).toBe("[]");
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 90_000);

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
    ]);
  }, 60_000);

  // KNOWN BUG (BOS-1020 finding): the old bare #/funding and #/secrets carry no company id, and App.tsx resolves the
  // company for the redirect from the address only (never the company already selected), so they land on the bare
  // #/settings menu instead of Funding / Secrets. When fixed, this test starts passing and `it.fails` flags it:
  // change it to a plain `it`.
  it.fails("lands the old bare #/funding and #/secrets on Funding and Secrets", async () => {
    await landsOn([
      ["funding", "settings/c1/funding"],
      ["secrets", "settings/c1/secrets"],
    ]);
  }, 60_000);
});
