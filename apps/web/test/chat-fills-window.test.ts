import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

// The chat fills the window (BOS-270), checked on the REAL Chat page (BOS-964). BOS-270 had no
// rendered test at all, so a layout change could quietly bring back the blank band below the panel
// or push the message box out of view, exactly as BOS-554's wheel fix came back (BOS-962).
//
// The harness is the one BOS-962 built: Vite serves the real app in-process and every `/api/*` read
// is answered from fixture JSON with `page.route`, so nothing here is hand-written HTML. The page is
// opened at the devices-tool profiles (a wide desktop and the owner's foldable), plus a 380px phone.
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

type Server = { resolvedUrls: { local: string[] }; close: () => Promise<void> };
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
    return { resolvedUrls: { local: server.resolvedUrls.local }, close: async () => { await server.close(); } };
  } catch {
    return null;
  }
}

// The owner's unfolding foldable, as the devices tool recorded it: 1667 CSS px wide, a 724 px tall
// viewport (the browser chrome of the installed app), pixel ratio 3, touch.
const foldable = { width: 1667, height: 724, coarsePointer: true };

const browser = await launch();
const server = await startVite();
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const agent = { id: "a1", name: "Brave - Web Developer", role: "ceo", status: "idle" };
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", agents: [agent] };
const project = { id: "p1", companyId: "c1", name: "Development", repoUrl: null, defaultBranch: "main", verifyCommand: null, deepVerifyCommand: null, landing: "merge", gitHost: null, gitApiBase: null, starred: false, ticketCostCapMicros: null, monthlyCapMicros: null };
const thread = { id: "a1", name: "Brave", role: "ceo", duty: null, state: "idle", last: { role: "assistant", text: "Here is the latest on the board.", createdAt: new Date().toISOString() } };
const messages = Array.from({ length: 24 }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 === 0 ? "owner" : "assistant",
  text: `Message ${i + 1}: a line long enough that it wraps onto a second line in the conversation, so the log really has room to scroll.`,
  createdAt: new Date(Date.now() - (24 - i) * 60_000).toISOString(),
}));
const api: Record<string, unknown> = {
  "/api/setup": { needsSetup: false },
  "/api/me": { username: "owner" },
  "/api/companies": [company],
  "/api/decisions": [],
  "/api/decisions/advised": [],
  "/api/decisions/with-team": [],
  "/api/decisions/closed-notices": [],
  "/api/decisions/tally": { open: 0, waiting: 0 },
  "/api/runs": [],
  "/api/notifications": { items: [], unread: 0 },
  "/api/maintenance": { on: false },
  "/api/feedback/unprocessed": {},
  "/api/setup-progress": { dismissed: true },
  "/api/companies/c1/merge-queue": { waitingCount: 0, stuckCount: 0 },
  "/api/companies/c1/projects": [project],
  "/api/companies/c1/chat/threads": [thread],
  "/api/companies/c1/chat": { agentId: "a1", state: "idle", items: messages },
  "/api/companies/c1/review-policy": {},
  "/api/companies/c1/watchdog": { settings: { enabled: false }, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0 },
  "/api/policy": {},
};

/** The chat page with a picked thread (`#/chat/c1/a1`), at one window size. */
async function openChat(width: number, height: number, hasTouch: boolean): Promise<Page> {
  const page = (await browser!.newPage({ viewport: { width, height }, hasTouch, isMobile: hasTouch })) as Page;
  await page.route("**/api/**", (route: any) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api[path] ?? {}) });
  });
  await page.goto(`${server!.resolvedUrls.local[0]}#/chat/c1/a1`, { waitUntil: "networkidle" });
  // The panel paints once its data poll answers; wait for a real message and the message box.
  await page.waitForSelector(".messenger .chat-log .chat-msg", { timeout: 15_000 });
  await page.waitForSelector(".messenger .chat-form textarea", { timeout: 15_000 });
  return page;
}

type Metrics = {
  winH: number;
  messenger: { top: number; bottom: number; height: number };
  mainContentBottom: number;
  pageScrollHeight: number;
  form: { top: number; bottom: number; height: number };
  log: { top: number; bottom: number; height: number };
};

/** Where the panel and the message box actually are, in window coordinates. */
async function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const rect = (sel: string) => {
      const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    const main = document.querySelector(".app > main") as HTMLElement;
    const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0;
    return {
      winH: window.innerHeight,
      messenger: rect(".messenger"),
      // The bottom of the room the page has to fill, inside `main`'s own bottom padding.
      mainContentBottom: Math.round(main.getBoundingClientRect().bottom - pad),
      pageScrollHeight: document.documentElement.scrollHeight,
      form: rect(".messenger .chat-form"),
      log: rect(".messenger .chat-log"),
    };
  });
}

/**
 * The claim BOS-270 made, as a measurement: the panel takes the room `main` has under the heading, so
 * its foot sits at the foot of that room (less the 24px page gap and rounding); the message box is
 * inside the window and not clipped by the panel; and the page itself does not scroll, because the
 * conversation scrolls inside the panel. Before BOS-270 the panel stopped at `min(72vh, 760px)` and
 * left a blank band below it, which is what fails these checks.
 */
function expectFillsWindow(m: Metrics, where: string): void {
  // The panel ends where the page's room ends (its foot, less the 24px page gap and rounding), not short of it.
  expect(m.mainContentBottom - m.messenger.bottom, `${where}: the chat panel must reach the foot of the page area, not stop short of it`).toBeLessThanOrEqual(30);
  expect(m.messenger.height, `${where}: the chat panel must have real height`).toBeGreaterThan(240);
  // The message box is in the window and inside the panel, so it is on screen to type in.
  expect(m.form.bottom, `${where}: the message box must be inside the window`).toBeLessThanOrEqual(m.winH);
  expect(m.form.top, `${where}: the message box must be below the top of the window`).toBeGreaterThanOrEqual(0);
  expect(m.form.height, `${where}: the message box must have real height`).toBeGreaterThan(20);
  expect(m.log.bottom, `${where}: the conversation must end above the message box`).toBeLessThanOrEqual(m.form.top + 1);
  // The page does not scroll: the conversation does, inside the panel.
  expect(m.pageScrollHeight, `${where}: the page must not scroll; the conversation does`).toBeLessThanOrEqual(m.winH + 1);
}

describe.skipIf(!browser || !server)("the real Chat page fills the window (BOS-270, BOS-964)", () => {
  it("at a wide desktop: the panel reaches the foot of the page and the message box is on screen", async () => {
    const page = await openChat(1440, 900, false);
    try {
      expectFillsWindow(await measure(page), "desktop 1440×900");
      // The conversation really is a scroll container here, so "the page does not scroll" is the
      // panel's doing and not an empty log.
      const log = await page.evaluate(() => {
        const el = document.querySelector(".messenger .chat-log") as HTMLElement;
        return { sh: el.scrollHeight, ch: el.clientHeight };
      });
      expect(log.sh, "desktop: the conversation should scroll inside the panel").toBeGreaterThan(log.ch);
    } finally {
      await page.close();
    }
  });

  it("the panel grows with the window: a taller window gives the chat the extra room, it is not capped", async () => {
    // BOS-270 replaced a fixed `min(72vh, 760px)` height with "what the heading leaves". So growing the
    // window must grow the panel by the same amount (up to rounding), not stop at a cap: the old code
    // gave 521px at the foldable's 724-tall window and barely more at 1100, leaving a blank band.
    const short = await measure(await openChat(1440, 900, false));
    const tall = await measure(await openChat(1440, 1100, false));
    const grew = tall.messenger.height - short.messenger.height;
    const windowGrew = tall.winH - short.winH;
    expect(windowGrew).toBe(200);
    expect(grew, "the chat panel must take the window's extra height, not stop at a fixed height").toBeGreaterThanOrEqual(windowGrew - 8);
  });

  it("at the owner's foldable: the panel fills the window under the menu bar", async () => {
    const t = foldable;
    const page = await openChat(t.width, t.height, t.coarsePointer);
    try {
      expectFillsWindow(await measure(page), "foldable 1667×724");
    } finally {
      await page.close();
    }
  });

  it("at a phone: the open thread fills what the menu bar leaves, and the message box stays in view", async () => {
    // A 380px-wide touch phone; the window is the shorter (visual) viewport, as with a keyboard gap.
    const page = await openChat(380, 620, true);
    try {
      expectFillsWindow(await measure(page), "phone 380×620");
      // On a phone the team list gives way to the open thread, so the message box is the one on screen.
      const seen = await page.evaluate(() => ({
        list: getComputedStyle(document.querySelector(".messenger-list") as HTMLElement).display,
        form: getComputedStyle(document.querySelector(".messenger .chat-form") as HTMLElement).display,
      }));
      expect(seen.list, "phone: the team list gives way to the open thread").toBe("none");
      expect(seen.form, "phone: the message box is shown").not.toBe("none");
    } finally {
      await page.close();
    }
  });
});
