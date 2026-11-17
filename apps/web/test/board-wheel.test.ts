import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport, tallestReading } from "@boss-man/shared";

// Real wheel over the REAL Kanban board (BOS-962, regression of BOS-554). The old guard only read
// the CSS text, so a layout change could bring the fault back with every test still green. This
// mounts the actual Board page in a browser (Vite in-process, /api answered with fixtures) and turns
// the mouse wheel with real input events over the middle of the board at a wide desktop size and at
// the owner's foldable profile, asserting the page moves. A sideways-only box that is a pixel taller
// than its frame eats the wheel, so one wheel anywhere over the board must scroll the page.
//
// The tabs are checked too: their buttons carry a 3px border and a -1px margin, so the strip is one
// pixel taller than its frame. If `overflow-y: hidden` is ever dropped there, the wheel died over it
// on 6 Nov (BOS-554); this test then fails.
//
// Skipped, not failed, where no browser or Vite is installed (the runner and CI have both).

type Page = Awaited<ReturnType<Browser["newPage"]>>;
type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean; isMobile?: boolean }) => Promise<any>;
  close: () => Promise<void>;
};

async function launch(): Promise<Browser | null> {
  let chromium: { launch: (opts?: { executablePath?: string; args?: string[] }) => Promise<Browser> };
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
    } catch {
      // try the next one
    }
  }
  return null;
}

type Server = { resolvedUrls: { local: string[] }; listen: () => Promise<void>; close: () => Promise<void> };
async function startVite(): Promise<Server | null> {
  let vite: typeof import("vite");
  try {
    vite = await import("vite");
  } catch {
    return null;
  }
  try {
    const server = await vite.createServer({ configFile: new URL("../vite.config.ts", import.meta.url).pathname, server: { port: 0, host: "127.0.0.1" }, logLevel: "silent" });
    await server.listen();
    if (!server.resolvedUrls?.local[0]) return null;
    return { resolvedUrls: { local: server.resolvedUrls.local }, listen: async () => { await server.listen(); }, close: async () => { await server.close(); } };
  } catch {
    return null;
  }
}

// The owner's unfolding foldable, as the devices tool recorded it: 1667 CSS px wide, a 724 px tall
// viewport (the browser chrome of the installed app), pixel ratio 3, touch.
const foldable: DeviceReport = DeviceReport.parse({
  label: "Brave · 1667px · touch",
  browser: "Brave",
  fingerprint: "bos-962-foldable",
  readings: [
    { width: 1667, height: 1668, pixelRatio: 3, coarsePointer: true, displayMode: "standalone", units: { vh: 724, dvh: 724, svh: 724, lvh: 724, visual: 724 }, afterScroll: false },
  ],
});

const browser = await launch();
const server = await startVite();
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

// A small, real-shaped board: a project, its columns, and enough cards that the columns run below
// the fold. `waitingOnOwner` puts two tasks in the "Your review" lane, as the owner saw.
const agent = { id: "a1", name: "Bungle - Web Developer", role: "engineer", status: "idle" };
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", agents: [agent] };
const project = { id: "p1", companyId: "c1", name: "Development", repoUrl: null, defaultBranch: "main", verifyCommand: null, deepVerifyCommand: null, landing: "merge", gitHost: null, gitApiBase: null, starred: false, ticketCostCapMicros: null, monthlyCapMicros: null };
const ticket = (id: string, state: string, n: number, waiting = false) => ({ id, title: `Ticket number ${n} with a title long enough to wrap onto two lines in a card`, number: n, systemState: state, outcome: null, assigneeAgentId: "a1", assignedToOwner: false, dueDate: null, blockedBy: [], branch: "b", risk: "low", size: 2, planFirst: false, plan: null, planApprovedAt: null, featureId: null, body: null, lastActivityAt: new Date().toISOString(), waitingOnOwner: waiting });
const columns = (["ready", "in_progress", "blocked", "review", "done"] as const).map((state, i) => ({ id: `col${i}`, name: state, systemState: state, wipLimit: null, tickets: Array.from({ length: 12 }, (_, j) => ticket(`t${i}-${j}`, state, i * 100 + j, state === "review")) }));
const board = { project, workingAgents: 0, withoutTicket: [], columns };
const api: Record<string, unknown> = {
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
  "/api/projects/p1/board": board,
  "/api/companies/c1/features": { features: [], criteria: [] },
  "/api/companies/c1/objectives": { objectives: [], keyResults: [] },
  "/api/companies/c1/review-policy": {},
  "/api/companies/c1/watchdog": { settings: { enabled: false }, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0 },
  "/api/policy": {},
};

async function openBoard(width: number, height: number, hasTouch: boolean): Promise<Page> {
  const page = (await browser!.newPage({ viewport: { width, height }, hasTouch, isMobile: hasTouch })) as Page;
  await page.route("**/api/**", (route: any) => {
    const path = new URL(route.request().url()).pathname;
    // An answer in flight when the test closes its page rejects with "has been closed": expected, not a failure (BOS-1708).
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api[path] ?? {}) }).catch((e: unknown) => {
      if (!/closed/i.test(String((e as Error)?.message ?? e))) throw e;
    });
  });
  await page.goto(`${server!.resolvedUrls.local[0]}#board/p1`, { waitUntil: "networkidle" });
  // The board paints once its data poll answers; wait for a real card.
  await page.waitForSelector(".board-scroll .ticket h3", { timeout: 15_000 });
  return page;
}

/** The pixel point of the middle of an element, clipped into the window. */
async function pointOf(page: Page, selector: string, fx = 0.5, fy = 0.5): Promise<{ x: number; y: number }> {
  return page.evaluate(([sel, fx, fy]: [string, number, number]) => {
    const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    return { x: Math.round(Math.min(vw - 4, Math.max(1, r.left + r.width * fx))), y: Math.round(Math.min(vh - 4, Math.max(1, r.top + r.height * fy))) };
  }, [selector, fx, fy]);
}

/**
 * The board must be sideways-only: it may be wider than its frame, but never taller. A
 * sideways-only box that is even one pixel taller than its frame becomes a vertical scroll
 * container and swallows the wheel (BOS-554), so assert the cause, not just the symptom.
 */
async function expectSidewaysOnly(page: Page, selector: string): Promise<void> {
  const m = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement;
    return { sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY };
  }, selector);
  expect(m.sh, `${selector} must not be taller than its frame`).toBeLessThanOrEqual(m.ch + 1);
  expect(m.oy, `${selector} must set overflow-y: hidden`).toBe("hidden");
}

/** A real wheel notch, then how far the page moved and which element was under the pointer. */
async function wheel(page: Page, x: number, y: number, deltaY: number, deltaX = 0): Promise<{ scrollY: number; under: string }> {
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  const under = await page.evaluate(([x, y]: [number, number]) => {
    const e = document.elementFromPoint(x, y);
    return e ? `${e.tagName}.${String((e as HTMLElement).className)}` : "nothing";
  }, [x, y]);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, pointerType: "mouse" });
  // Wait for the page to actually move (smooth scrolling on a slow GitHub runner can still be at 0
  // after a fixed sleep). A sideways wheel moves the board instead, so wait for that: once the
  // board has scrolled, the wheel has been handled, and a stray page scroll would have shown by
  // now. A timeout is not an error here: the caller's assertion reports a wheel that did nothing.
  try {
    if (deltaY !== 0) await page.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 10_000 });
    else await page.waitForFunction(() => (document.querySelector(".board-scroll") as HTMLElement).scrollLeft > 0, undefined, { timeout: 10_000 });
  } catch {
    /* fall through to the read below */
  }
  const scrollY = await page.evaluate(() => window.scrollY);
  await cdp.detach();
  return { scrollY, under };
}

describe.skipIf(!browser || !server)("the mouse wheel over the real Kanban board scrolls the page (BOS-962)", () => {
  it("at a wide desktop: over a card, a gap and a lane, the page moves", async () => {
    const page = await openBoard(1440, 900, false);
    try {
      await expectSidewaysOnly(page, ".board-scroll");
      // A card in the middle of the board, the gap beside the lanes, and the lane's blank lower part.
      for (const [sel, fx, fy] of [[" .board-scroll .ticket", 0.5, 0.4], [".board-scroll", 0.98, 0.6], [".board", 0.5, 0.95]] as const) {
        const p = await pointOf(page, sel.trim(), fx, fy);
        const r = await wheel(page, p.x, p.y, 400);
        expect(r.scrollY, `wheel over ${r.under} (${sel}) should scroll the page`).toBeGreaterThan(0);
      }
    } finally {
      await page.close();
    }
  });

  it("at the owner's foldable: over the middle of the board, the page moves", async () => {
    const t = tallestReading(foldable);
    const page = await openBoard(t.width, t.units.visual, t.coarsePointer);
    try {
      await expectSidewaysOnly(page, ".board-scroll");
      const p = await pointOf(page, ".board-scroll .ticket", 0.5, 0.5);
      const r = await wheel(page, p.x, p.y, 400);
      expect(r.scrollY, `wheel over ${r.under} should scroll the page`).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  it("sideways still works: a horizontal wheel or trackpad swipe reaches the columns past the edge", async () => {
    const page = await openBoard(1440, 900, false);
    try {
      const before = await page.evaluate(() => (document.querySelector(".board-scroll") as HTMLElement).scrollLeft);
      // Start at the left of the board and push sideways; the board must move, not the page.
      const p = await pointOf(page, ".board-scroll", 0.5, 0.5);
      const r = await wheel(page, p.x, p.y, 0, 300);
      const after = await page.evaluate(() => (document.querySelector(".board-scroll") as HTMLElement).scrollLeft);
      expect(after, "the board should scroll sideways to reach the Done column").toBeGreaterThan(before);
      expect(r.scrollY, "a sideways wheel must not scroll the page").toBe(0);
    } finally {
      await page.close();
    }
  });

  it("the tabs' one-pixel-taller strip does not eat the wheel either", async () => {
    const page = await openBoard(1440, 900, false);
    try {
      // The tabs are 1px taller than their frame (3px border, -1px margin): without
      // `overflow-y: hidden` the wheel over them scrolls a pixel and stops (BOS-554).
      const strip = await page.evaluate(() => {
        const t = document.querySelector(".tabs") as HTMLElement;
        return { sh: t.scrollHeight, ch: t.clientHeight, oy: getComputedStyle(t).overflowY };
      });
      expect(strip.sh).toBeGreaterThan(strip.ch);
      expect(strip.oy).toBe("hidden");
      const p = await pointOf(page, ".tabs", 0.5, 0.5);
      const r = await wheel(page, p.x, p.y, 400);
      expect(r.scrollY, `wheel over ${r.under} should scroll the page`).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
