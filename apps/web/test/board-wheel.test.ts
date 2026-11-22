import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport, tallestReading } from "@boss-man/shared";

// Real wheel over the REAL Kanban board (BOS-962, regression of BOS-554; BOS-1915 the third time).
// This mounts the actual Board page in a browser (Vite in-process, /api answered with fixtures) and
// turns the mouse wheel with real input events, asserting the page moves.
//
// Why the BOS-962 version missed BOS-1915: it only sent perfectly vertical wheel ticks (deltaX 0),
// from the top of the page, over three points of a small board. A real mouse or trackpad on a Mac
// adds a pixel or two of sideways movement. The browser hands such an event to the board (it can
// scroll sideways) and the board drops the vertical part; Safari then keeps the whole gesture on
// the board, so the page stops responding. A vertical-only tick never shows that. So this version:
//   - fills the board like the owner's (19+ cards in the busy lanes, the live-check, merging and
//     "Your review" lanes, the "waiting on you" and "other projects" banners at the top),
//   - points at every area (banners, filter row, lane headers, the long lane description, cards,
//     the gap between two cards, the empty part of a short lane, an empty lane's text, the cut-off
//     column at the right edge, the tabs),
//   - from the top and part-way down the page, with the board's sideways scroll at 0 and not at 0,
//   - sends both a vertical-only tick and a tick with a little sideways movement, and a whole
//     gesture of such ticks,
//   - and checks sideways input (a sideways swipe, shift+wheel) still scrolls the board.
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
// The owner's desktop with a mouse (BOS-1915 was reported there), as the devices tool recorded it:
// 1550 CSS px wide, a 1594 px visual viewport. Its pixel ratio is 2, but this runs at 1: Playwright's
// emulated ratio hands the page half the wheel amount (deltaY 30 for a 60 px tick) while the
// browser's own scroll moves the full 60, which a real Retina screen doesn't do, and which would
// make the page-scrolled-by-code case look short. The ratio plays no part in which element gets the wheel.
const desktop = { width: 1550, height: 1594, deviceScaleFactor: 1 };

const browser = await launch();
const server = await startVite();
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

// A board as full as the owner's on 19 Nov: 13 in Backlog, 1 in Ready, 19 in progress, 19 blocked
// plus 16 merged and waiting for a live check (their own lane, with its long description), an empty
// "Awaiting review" lane, 8 approved and merging, 2 waiting on the owner ("Your review" lane and the
// banner at the top), Done, and the "Working on other projects" banner.
const agent = { id: "a1", name: "Bungle - Web Developer", role: "engineer", status: "idle" };
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", agents: [agent] };
const project = { id: "p1", companyId: "c1", name: "Development", repoUrl: null, defaultBranch: "main", verifyCommand: null, deepVerifyCommand: null, landing: "merge", gitHost: null, gitApiBase: null, starred: false, ticketCostCapMicros: null, monthlyCapMicros: null };
const ticket = (id: string, state: string, n: number, extra: Record<string, unknown> = {}) => ({ id, title: `Ticket number ${n} with a title long enough to wrap onto two lines in a card`, number: n, systemState: state, outcome: null, assigneeAgentId: "a1", assignedToOwner: false, dueDate: null, blockedBy: [], branch: "b", risk: "low", size: 2, planFirst: false, plan: null, planApprovedAt: null, featureId: null, body: null, lastActivityAt: new Date().toISOString(), waitingOnOwner: false, ...extra });
const counts = { backlog: 13, ready: 1, in_progress: 19, blocked: 19, review: 0, done: 20 } as const;
const columns = (Object.keys(counts) as Array<keyof typeof counts>).map((state, i) => {
  const tickets = Array.from({ length: counts[state] }, (_, j) => ticket(`t${i}-${j}`, state, i * 100 + j));
  if (state === "blocked") for (let j = 0; j < 16; j++) tickets.push(ticket(`lc${j}`, state, 900 + j, { mergeCommit: "abc1234", goLiveNote: "Merged and live. Waiting for the agent to report the after-merge check. Nothing for you to do." }));
  if (state === "review") {
    for (let j = 0; j < 8; j++) tickets.push(ticket(`m${j}`, state, 800 + j, { reviewStage: "merging" }));
    tickets.push(ticket("w1", state, 700, { waitingOnOwner: true }), ticket("w2", state, 701, { waitingOnOwner: true }));
  }
  return { id: `col${i}`, name: state, systemState: state, wipLimit: null, tickets };
});
const otherProjects = [{ id: "r1", agent: "Brian - Release Manager", ticketId: "x1", ticketNumber: 1912, ticketTitle: "Website: set the analytics settings for the site publish, republish, then run the live visit and click check", projectId: "p2", projectName: "Boss Man Website", startedAt: new Date().toISOString() }];
const board = { project, workingAgents: 0, withoutTicket: [], otherProjects, columns };
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

async function openBoard(opts: { width: number; height: number; deviceScaleFactor?: number; hasTouch?: boolean }): Promise<Page> {
  const page = (await browser!.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: opts.deviceScaleFactor, hasTouch: !!opts.hasTouch, isMobile: !!opts.hasTouch })) as Page;
  await page.route("**/api/**", (route: any) => {
    const path = new URL(route.request().url()).pathname;
    // An answer in flight when the test closes its page rejects with "has been closed": expected, not a failure (BOS-1708).
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api[path] ?? {}) }).catch((e: unknown) => {
      if (!/closed/i.test(String((e as Error)?.message ?? e))) throw e;
    });
  });
  await page.goto(`${server!.resolvedUrls.local[0]}#board/p1`, { waitUntil: "networkidle" });
  // The board paints once its data poll answers; wait for the last lane's cards, so every lane is there.
  await page.waitForSelector(".board-scroll #lane-live-check", { timeout: 15_000 });
  await page.waitForSelector(".board-scroll .ticket h3", { timeout: 15_000 });
  return page;
}

/** The pixel point of an element, clipped into the window. */
async function pointOf(page: Page, selector: string, fx = 0.5, fy = 0.5): Promise<{ x: number; y: number }> {
  return page.evaluate(([sel, fx, fy]: [string, number, number]) => {
    const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    return { x: Math.round(Math.min(vw - 4, Math.max(1, r.left + r.width * fx))), y: Math.round(Math.min(vh - 4, Math.max(1, r.top + r.height * fy))) };
  }, [selector, fx, fy]);
}

/**
 * Every area of the board the pointer can rest on, as a point in the window right now, or null
 * when that area is scrolled out of view. Run in the page.
 */
const AREAS = ["waiting-on-you banner", "other-projects banner", "filter row", "lane header", "live-check lane description", "card", "gap between cards", "below a short lane", "empty lane text", "cut-off column at the right edge", "tabs"] as const;
type Area = (typeof AREAS)[number];

async function areaPoint(page: Page, area: Area): Promise<{ x: number; y: number } | null> {
  return page.evaluate((area: string) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = (sel: string, i = 0) => (document.querySelectorAll(sel)[i] as HTMLElement | undefined)?.getBoundingClientRect() ?? null;
    const inside = (x: number, y: number) => (x >= 1 && x <= vw - 4 && y >= 1 && y <= vh - 4 ? { x: Math.round(x), y: Math.round(y) } : null);
    const mid = (b: DOMRect | null) => (b ? inside(Math.max(b.left, 0) + Math.min(b.width, vw - Math.max(b.left, 0)) / 2, Math.max(b.top, 0) + Math.min(b.height, vh - Math.max(b.top, 0)) / 2) : null);
    const lanes = Array.from(document.querySelectorAll(".board-scroll .lane")) as HTMLElement[];
    const visibleLane = lanes.find((l) => { const b = l.getBoundingClientRect(); return b.left >= 0 && b.right <= vw; });
    switch (area) {
      case "waiting-on-you banner": return mid(r("a.strip"));
      case "other-projects banner": return mid(r(".unticketed"));
      case "filter row": { const b = r(".board-bar"); return b ? inside(b.left + b.width * 0.7, b.top + b.height / 2) : null; }
      case "lane header": return visibleLane ? mid(visibleLane.querySelector(".lane-head")!.getBoundingClientRect()) : null;
      case "live-check lane description": { const l = document.getElementById("lane-live-check")?.closest(".lane"); return mid(l?.querySelector(".lane-hint")?.getBoundingClientRect() ?? null); }
      case "card": { const cards = Array.from(document.querySelectorAll(".board-scroll .ticket")) as HTMLElement[]; const c = cards.find((c) => mid(c.getBoundingClientRect()) && c.getBoundingClientRect().right <= vw); return c ? mid(c.getBoundingClientRect()) : null; }
      case "gap between cards": {
        for (const lane of lanes) {
          const cards = Array.from(lane.querySelectorAll(":scope > .ticket, :scope > * > .ticket")) as HTMLElement[];
          for (let i = 0; i + 1 < cards.length; i++) {
            const a = cards[i]!.getBoundingClientRect();
            const b = cards[i + 1]!.getBoundingClientRect();
            const p = a.right <= vw ? inside(a.left + a.width / 2, (a.bottom + b.top) / 2) : null;
            if (p && b.top - a.bottom >= 2) return p;
          }
        }
        return null;
      }
      case "below a short lane": {
        const ready = lanes.find((l) => l.querySelector("h2")?.textContent === "ready")?.getBoundingClientRect();
        return ready ? inside(ready.left + ready.width / 2, Math.max(ready.bottom + 60, 60)) : null;
      }
      case "empty lane text": { const e = Array.from(document.querySelectorAll(".board-scroll .lane-empty")).map((e) => e.getBoundingClientRect()).find((b) => b.right <= vw); return mid(e ?? null); }
      case "cut-off column at the right edge": {
        // The board's own right edge cuts the column (the board stops short of the window edge).
        const edge = Math.min(vw, (document.querySelector(".board-scroll") as HTMLElement).getBoundingClientRect().right);
        // The last few pixels before that edge: the cut-off column's sliver (or, at a width where a
        // gap falls there, the gap beside it), whichever the layout puts under the pointer.
        const top = lanes[0]!.getBoundingClientRect().top;
        return inside(edge - 4, Math.max(top + 120, 120));
      }
      case "tabs": return mid(r(".tabs"));
      default: return null;
    }
  }, area);
}

type ScrollState = { y: number; left: number };
async function setScroll(page: Page, s: ScrollState): Promise<void> {
  await page.evaluate(([y, left]: [number, number]) => {
    window.scrollTo(0, y);
    (document.querySelector(".board-scroll") as HTMLElement).scrollLeft = left;
  }, [s.y, s.left]);
}
const read = (page: Page): Promise<ScrollState> => page.evaluate(() => ({ y: window.scrollY, left: (document.querySelector(".board-scroll") as HTMLElement).scrollLeft }));

// One browser debug session per page, opened on the first wheel and dropped with the page: opening
// one per wheel (about 80 in the first test) was the slowest part on a busy GitHub runner (BOS-1949).
const sessions = new WeakMap<object, Promise<any>>();
function cdpFor(page: Page): Promise<any> {
  let s = sessions.get(page);
  if (!s) {
    s = page.context().newCDPSession(page) as Promise<any>;
    sessions.set(page, s);
  }
  return s;
}

// Each walk sends ~20 real wheel turns, each waiting for the scroll to settle (3 quiet reads);
// on a runner several times slower than ours that can pass the 30 s default. Each wait inside has its
// own 10 s deadline, so this limit only bounds the whole walk: a hung wheel still fails.
const WALK_TIMEOUT_MS = 150_000;

/**
 * Real wheel events at one point (one per entry in `ticks`, sent back to back like one gesture),
 * then wait for the page or the board to move. A timeout is not an error here: the caller's
 * assertion reports a wheel that did nothing.
 */
async function wheel(page: Page, x: number, y: number, ticks: Array<{ dx: number; dy: number }>, modifiers = 0): Promise<{ moved: ScrollState; under: string }> {
  const cdp = await cdpFor(page);
  const before = await read(page);
  const under = await page.evaluate(([x, y]: [number, number]) => {
    const e = document.elementFromPoint(x, y);
    return e ? `${e.tagName}.${String((e as HTMLElement).className)}` : "nothing";
  }, [x, y]);
  for (const t of ticks) await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: t.dx, deltaY: t.dy, modifiers, pointerType: "mouse" });
  // Wait for the move to finish (smooth scrolling on a slow GitHub runner can still be under way):
  // until the position stops changing for 3 reads in a row after it first moved.
  try {
    await page.waitForFunction(
      ([y0, l0]: [number, number]) => {
        const w = window as unknown as { __wheelSeen?: string[] };
        const now = `${window.scrollY},${(document.querySelector(".board-scroll") as HTMLElement).scrollLeft}`;
        if (now === `${y0},${l0}`) return false;
        const seen = (w.__wheelSeen = [...(w.__wheelSeen ?? []), now].slice(-3));
        return seen.length === 3 && seen.every((s) => s === now);
      },
      [before.y, before.left],
      { timeout: 10_000, polling: 50 },
    );
  } catch {
    /* fall through to the read below */
  }
  await page.evaluate(() => { delete (window as unknown as { __wheelSeen?: string[] }).__wheelSeen; });
  const after = await read(page);
  return { moved: { y: after.y - before.y, left: after.left - before.left }, under };
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

describe.skipIf(!browser || !server)("the mouse wheel over the real Kanban board scrolls the page (BOS-962, BOS-1915)", () => {
  // One test per starting position (BOS-1949): the whole walk in one test was ~80 wheel turns and went over the limit on a slow runner.
  it.each([
    { label: "top of the page, board at its left edge", y: 0, at: 0 },
    { label: "top of the page, board half way across", y: 0, at: 0.5 },
    { label: "400 px down, board at its left edge", y: 400, at: 0 },
    { label: "400 px down, board at its right end", y: 400, at: 1 },
  ])("at the owner's desktop, $label: every area, plain and slightly sideways wheels", async ({ y, at }) => {
    const page = await openBoard(desktop);
    try {
      await expectSidewaysOnly(page, ".board-scroll");
      const maxLeft = await page.evaluate(() => { const b = document.querySelector(".board-scroll") as HTMLElement; return b.scrollWidth - b.clientWidth; });
      expect(maxLeft, "the full board must be wider than the window, as the owner's is").toBeGreaterThan(100);
      const failures: string[] = [];
      for (const start of [{ y, left: Math.round(maxLeft * at) }]) {
        for (const area of AREAS) {
          // At the top of the page every area must be on screen, so none is skipped by accident.
          await setScroll(page, start);
          const p = await areaPoint(page, area);
          if (!p) {
            if (start.y === 0 && !(area === "cut-off column at the right edge" && start.left > 0)) failures.push(`${area} not found on screen at ${JSON.stringify(start)}`);
            continue;
          }
          for (const ticks of [[{ dx: 0, dy: 100 }], [{ dx: 2, dy: 100 }]]) {
            await setScroll(page, start);
            const r = await wheel(page, p.x, p.y, ticks);
            const what = `${area} at ${JSON.stringify(start)}, wheel ${JSON.stringify(ticks[0])} over ${r.under}`;
            if (r.moved.y <= 0) failures.push(`${what}: the page did not move`);
            if (r.moved.left !== 0) failures.push(`${what}: the board moved sideways by ${r.moved.left}`);
          }
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    } finally {
      await page.close();
    }
  }, WALK_TIMEOUT_MS);

  it("a whole gesture with a little sideways movement keeps scrolling the page (the Magic Mouse and trackpad case)", async () => {
    const page = await openBoard(desktop);
    try {
      for (const area of ["card", "gap between cards", "below a short lane"] as const) {
        await setScroll(page, { y: 0, left: 0 });
        const p = (await areaPoint(page, area))!;
        // The baseline: the same six ticks straight down, which the browser hands to the page. (The
        // pixel ratio scales the delivered amount, so compare with this, not with 6 x 60.)
        const straight = await wheel(page, p.x, p.y, Array.from({ length: 6 }, () => ({ dx: 0, dy: 60 })));
        expect(straight.moved.y, `straight-down gesture over ${area} (${straight.under}) should scroll the page`).toBeGreaterThan(0);
        await setScroll(page, { y: 0, left: 0 });
        const r = await wheel(page, p.x, p.y, Array.from({ length: 6 }, (_, i) => ({ dx: i % 2 ? 0 : 1, dy: 60 })));
        // Every tick must reach the page, not just the purely vertical ones: before BOS-1915 the
        // ones with a sideways pixel went to the board and the page moved half as far.
        expect(r.moved.y, `gesture over ${area} (${r.under}) should scroll the page as far as a straight-down one`).toBeGreaterThanOrEqual(straight.moved.y - 1);
        expect(r.moved.left, `gesture over ${area} must not move the board sideways`).toBe(0);
      }
    } finally {
      await page.close();
    }
  });

  it("at the owner's foldable: over the middle of the board, the page moves", async () => {
    const t = tallestReading(foldable);
    const page = await openBoard({ width: t.width, height: t.units.visual, hasTouch: t.coarsePointer });
    try {
      await expectSidewaysOnly(page, ".board-scroll");
      const p = await pointOf(page, ".board-scroll .ticket", 0.5, 0.5);
      for (const ticks of [[{ dx: 0, dy: 400 }], [{ dx: 3, dy: 400 }]]) {
        await setScroll(page, { y: 0, left: 0 });
        const r = await wheel(page, p.x, p.y, ticks);
        expect(r.moved.y, `wheel ${JSON.stringify(ticks[0])} over ${r.under} should scroll the page`).toBeGreaterThan(0);
      }
    } finally {
      await page.close();
    }
  });

  it("sideways still works: a sideways swipe or shift+wheel reaches the columns past the edge, and the page stays put", async () => {
    const page = await openBoard(desktop);
    try {
      const p = (await areaPoint(page, "card"))!;
      for (const [label, ticks, modifiers] of [
        ["a sideways trackpad swipe", [{ dx: 300, dy: 0 }], 0],
        ["a mostly sideways swipe", [{ dx: 300, dy: 20 }], 0],
        ["shift+wheel", [{ dx: 0, dy: 300 }], 8],
      ] as const) {
        await setScroll(page, { y: 0, left: 0 });
        const r = await wheel(page, p.x, p.y, [...ticks], modifiers);
        expect(r.moved.left, `${label} should scroll the board sideways`).toBeGreaterThan(0);
        expect(r.moved.y, `${label} must not scroll the page`).toBe(0);
      }
    } finally {
      await page.close();
    }
  });

  it("the tabs' one-pixel-taller strip does not eat the wheel either", async () => {
    const page = await openBoard({ width: 1440, height: 900 });
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
      await setScroll(page, { y: 0, left: 0 });
      const r = await wheel(page, p.x, p.y, [{ dx: 0, dy: 400 }]);
      expect(r.moved.y, `wheel over ${r.under} should scroll the page`).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
