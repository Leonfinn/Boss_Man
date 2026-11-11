// The real-page browser harness (BOS-962, shared by BOS-966). Before this, the layout tests pasted
// styles.css into a hand-written HTML page, never mounting the React app; Brains showed on BOS-962
// that a hand-written board does not show the wheel fault the real board has, so those tests missed
// real regressions. This mounts the actual app (Vite in-process, so the real components and
// stylesheet load) and answers `/api/*` from fixtures with page.route, in a real headless Chromium.
//
// Playwright is a global tool here, not a project dependency, so its own types aren't resolvable;
// the shapes below are the bits of its API the tests use. Vite and Playwright are skipped, not
// failed, where they are not installed (the runner and CI have both).
import { createRequire } from "node:module";

export type Page = Awaited<ReturnType<Browser["newPage"]>>;
export type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean; isMobile?: boolean }) => Promise<any>;
  close: () => Promise<void>;
};
export type Server = { resolvedUrls: { local: string[] }; close: () => Promise<void> };

// A skip with no reason is hard to chase (BOS-1095: the fenced check job skipped these and the
// gate log said nothing). Say why on stderr whenever the browser or Vite is not available.
const why = (what: string, e?: unknown) => {
  // Playwright's first line ("Target page, context or browser has been closed") hides Chromium's own stderr, which follows
  // in the message ([pid][err] lines). Keep those lines (not the long command line), folded to one line, so a log shows the cause.
  const lines = e instanceof Error ? e.message.split("\n").filter((l) => l.trim() && !/<launching>|<launched>|Call log:|Browser logs:/.test(l)) : [];
  const msg = e instanceof Error ? lines.slice(0, 6).join(" | ").slice(0, 700) : e === undefined ? "" : String(e);
  process.stderr.write(`real-page: ${what}${msg ? `: ${msg}` : ""} (TMPDIR length ${(process.env.TMPDIR ?? "").length}, HOME ${process.env.HOME ?? "unset"})\n`);
};

export async function launch(): Promise<Browser | null> {
  let chromium: { launch: (opts?: { executablePath?: string; args?: string[] }) => Promise<Browser> };
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch (e) {
    why("playwright not loadable", e);
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    // A launch that dies while the machine is busy (many test files start Chromium at once, beside other jobs) can work a moment
    // later; a missing executable never will, so that one is not retried.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await chromium.launch(executablePath ? { executablePath, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
      } catch (e) {
        why(`chromium launch failed (${executablePath ?? "playwright default"}, try ${attempt})`, e);
        if (/doesn't exist/.test(String((e as Error)?.message))) break;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  return null;
}

export async function startVite(): Promise<Server | null> {
  let vite: typeof import("vite");
  try {
    vite = await import("vite");
  } catch (e) {
    why("vite not importable", e);
    return null;
  }
  try {
    const server = await vite.createServer({ configFile: new URL("../vite.config.ts", import.meta.url).pathname, server: { port: 0, host: "127.0.0.1" }, logLevel: "silent" });
    await server.listen();
    if (!server.resolvedUrls?.local[0]) {
      why("vite listening but no local url");
      return null;
    }
    return { resolvedUrls: { local: server.resolvedUrls.local }, close: async () => { await server.close(); } };
  } catch (e) {
    why("vite failed to start", e);
    return null;
  }
}

// A small, real-shaped board: a project, its five fixed columns, and enough cards that the columns
// run below the fold. `waitingOnOwner` puts two tasks in the "Your review" lane, as the owner saw.
const agent = { id: "a1", name: "Bungle - Web Developer", role: "engineer", status: "idle", agentKind: "developer", companyId: "c1", model: null, fundingSourceId: null, paused: false, starred: false, duty: null };
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", agents: [agent] };
const project = { id: "p1", companyId: "c1", name: "Development", repoUrl: null, defaultBranch: "main", verifyCommand: null, deepVerifyCommand: null, landing: "merge", gitHost: null, gitApiBase: null, starred: false, ticketCostCapMicros: null, monthlyCapMicros: null, archivedAt: null };
const ticket = (id: string, state: string, n: number, waiting = false) => ({ id, title: `Ticket number ${n} with a title long enough to wrap onto two lines in a card`, number: n, systemState: state, outcome: null, assigneeAgentId: "a1", assignedToOwner: false, dueDate: null, blockedBy: [], branch: "b", risk: "low", size: 2, planFirst: false, plan: null, planApprovedAt: null, featureId: null, body: null, lastActivityAt: new Date().toISOString(), waitingOnOwner: waiting, reviewStage: state === "review" ? "awaiting_review" : null });
// 12 cards per column, so each column is taller than the 724px fold on the foldable and the page
// has to scroll; the scroll area still must not be the thing that scrolls vertically.
const columns = (["ready", "in_progress", "blocked", "review", "done"] as const).map((state, i) => ({ id: `col${i}`, name: state, systemState: state, wipLimit: null, tickets: Array.from({ length: 12 }, (_, j) => ticket(`t${i}-${j}`, state, i * 100 + j, state === "review" && j < 2)) }));
const board = { project, workingAgents: 0, withoutTicket: [], columns };

export const API: Record<string, unknown> = {
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

/** Answer every `/api/*` request from the fixture map (an unknown path gets `{}`, as a quiet server would). */
export async function stubApi(page: Page, api: Record<string, unknown> = API): Promise<void> {
  await page.route("**/api/**", (route: any) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api[path] ?? {}) });
  });
}

/**
 * Open the real app at a hash route with the fixtures answering, and wait for the board to paint.
 * `sideCollapsed` sets the saved side-menu choice before the app boots (omit to keep the app's own
 * default for the width); `toolbarGap` then imitates a phone's toolbar (100lvh − 100dvh).
 */
export async function openApp(
  browser: Browser,
  server: Server,
  opts: { width: number; height: number; pixelRatio?: number; hasTouch?: boolean; hash?: string; sideCollapsed?: boolean; toolbarGap?: number },
): Promise<Page> {
  const page = (await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: opts.pixelRatio, hasTouch: opts.hasTouch, isMobile: opts.hasTouch })) as Page;
  await stubApi(page);
  if (opts.sideCollapsed !== undefined) {
    // Set the saved choice before the app boots, so its first render already has it.
    await page.addInitScript((v: boolean) => {
      try {
        localStorage.setItem("bm-side-collapsed", v ? "1" : "0");
      } catch {
        // storage blocked: the app's default stands, and the render at least still runs
      }
    }, opts.sideCollapsed);
  }
  await page.goto(`${server.resolvedUrls.local[0]}${opts.hash ?? "#board/p1"}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".board-scroll .ticket h3", { timeout: 15_000 });
  if (opts.toolbarGap !== undefined && opts.toolbarGap > 0) await page.evaluate(SHORT_DVH, opts.toolbarGap);
  return page;
}

/**
 * Turn every `height: …dvh` into the shorter dynamic viewport the phone reported, so 100dvh < 100vh
 * as on the real device. Rules inside `@media` are walked too. Run after the page has loaded.
 */
export const SHORT_DVH = (gap: number) => {
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSStyleRule).style;
      const h = style?.getPropertyValue("height");
      if (h && h.endsWith("dvh")) style.setProperty("height", `calc(100vh - ${gap}px)`, "important");
      const nested = (rule as CSSMediaRule).cssRules;
      if (nested) walk(nested);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
};
