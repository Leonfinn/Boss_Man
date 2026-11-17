import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import type { TraceBody } from "@boss-man/shared";

// A real-browser render of the Thinking trace above an agent reply (BOS-1368, design BOS-1367): the
// closed one-line summary, the opened steps in order with their kinds, a step opened to its detail,
// and the live state while the agent is still working, at the owner's desktop and at phone width.
// Renders the real Chat page (Vite plus Playwright), every `/api/*` read answered from fixtures.
// Skipped, not failed, where no browser or Vite is installed.

type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean; isMobile?: boolean }) => Promise<any>;
  close: () => Promise<void>;
};
type Page = Awaited<ReturnType<Browser["newPage"]>>;

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

type Server = { local: string; close: () => Promise<void> };
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
    return { local: server.resolvedUrls.local[0], close: async () => { await server.close(); } };
  } catch {
    return null;
  }
}

const browser = await launch();
const server = await startVite();
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const agent = { id: "a1", name: "George", role: "ceo", status: "idle" };
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", agents: [agent] };
const project = { id: "p1", companyId: "c1", name: "Development", repoUrl: null, defaultBranch: "main", verifyCommand: null, deepVerifyCommand: null, landing: "merge", gitHost: null, gitApiBase: null, starred: false, ticketCostCapMicros: null, monthlyCapMicros: null };
const thread = { id: "a1", name: "George", role: "ceo", duty: null, state: "idle", last: { role: "assistant", text: "Here is the latest.", createdAt: new Date().toISOString() } };

const doneTrace: TraceBody = {
  secs: 42,
  steps: [
    { kind: "reasoning", summary: "I should read the ticket first.", input: "I should read the ticket first. Then look at the code.", ms: 3000 },
    { kind: "look", summary: "Read ticket BOS-1276 · Build the shared loader", input: "BOS-1276", output: "BOS-1276 · Build the shared loader", labels: { input: "Sent", output: "Got back" }, ms: 1200 },
    { kind: "command", summary: "Ran pnpm test", input: "pnpm test", output: "Test Files 12 passed", labels: { input: "Command", output: "Output" }, ms: 38_000 },
  ],
};
const liveTrace: TraceBody = {
  secs: 12,
  steps: [
    { kind: "reasoning", summary: "Searching the board.", input: "Searching the board.", ms: 2000 },
    { kind: "look", summary: "Searched tickets", input: "loader", ms: 0 },
  ],
};

const baseApi = (live?: TraceBody) => ({
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
  "/api/companies/c1/chat": {
    agentId: "a1",
    state: live ? "answering" : "idle",
    live: live ?? null,
    items: [
      { id: "m0", role: "owner", text: "What did the team do?", createdAt: new Date(Date.now() - 60_000).toISOString() },
      { id: "m1", role: "assistant", text: "Here is what they did.", createdAt: new Date().toISOString(), trace: doneTrace },
      { id: "m2", role: "assistant", text: "Short reply, no steps.", createdAt: new Date().toISOString() },
    ],
  },
  "/api/companies/c1/review-policy": {},
  "/api/companies/c1/watchdog": { settings: { enabled: false }, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0 },
  "/api/policy": {},
});

async function open(width: number, height: number, hasTouch: boolean, live?: TraceBody): Promise<Page> {
  const api = baseApi(live);
  const page = await browser!.newPage({ viewport: { width, height }, hasTouch, isMobile: hasTouch });
  await page.route("**/api/**", (route: { request: () => { url: () => string }; fulfill: (o: { status: number; contentType: string; body: string }) => Promise<void> }) => {
    const path = new URL(route.request().url()).pathname;
    // An answer in flight when the test closes its page rejects with "has been closed": expected, not a failure (BOS-1708).
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify((api as Record<string, unknown>)[path] ?? {}) }).catch((e: unknown) => {
      if (!/closed/i.test(String((e as Error)?.message ?? e))) throw e;
    });
  });
  await page.goto(`${server!.local}#/chat/c1/a1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".messenger .chat-log .chat-msg", { timeout: 15_000 });
  return page;
}

const desktop = { width: 1280, height: 900, touch: false };
const phone = { width: 390, height: 844, touch: true };

describe.skipIf(!browser || !server)("the Thinking trace in a real browser (BOS-1368)", () => {
  it("desktop: closed one-line summary, opened steps in order, a step's detail", async () => {
    const page = await open(desktop.width, desktop.height, desktop.touch);
    try {
      // The reply with steps has a closed trace; the short reply has none.
      const heads = await page.evaluate(() => [...document.querySelectorAll(".chat-msg.assistant .trace-head")].map((el) => el.textContent));
      expect(heads).toContain("Thought for 42 s · 3 steps");
      // Collapsed by default: no step list showing.
      expect(await page.evaluate(() => document.querySelectorAll(".chat-msg.assistant .trace-steps").length)).toBe(0);
      // Open it: the steps show in order, by kind.
      await page.evaluate(() => (document.querySelector(".chat-msg.assistant.has-trace .trace-head") as HTMLElement).click());
      await page.waitForSelector(".chat-msg.assistant.has-trace .trace-steps .step-row", { timeout: 5000 });
      const rows = await page.evaluate(() => [...document.querySelectorAll(".chat-msg.assistant.has-trace .step-row")].map((el) => ({ cls: el.className, text: el.querySelector(".sum")?.textContent })));
      expect(rows.map((r: { cls: string }) => r.cls)).toEqual([expect.stringContaining("k-think"), expect.stringContaining("k-look"), expect.stringContaining("k-run")]);
      expect(rows[1]!.text).toContain("Read ticket BOS-1276");
      // Open a step: its detail shows.
      await page.evaluate(() => (document.querySelector(".chat-msg.assistant.has-trace .step-row.k-run") as HTMLElement).click());
      await page.waitForSelector(".chat-msg.assistant.has-trace .step-detail", { timeout: 5000 });
      const detail = await page.evaluate(() => document.querySelector(".chat-msg.assistant.has-trace .step-detail")?.textContent ?? "");
      expect(detail).toContain("Command");
      expect(detail).toContain("pnpm test");
      // Nothing overflows the window width.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      if (process.env.BOSSMAN_SCRATCH) await page.screenshot({ path: `${process.env.BOSSMAN_SCRATCH}/trace-desktop-expanded.png` });
    } finally {
      await page.close();
    }
  });

  it("desktop: the live trace shows while the agent works", async () => {
    const page = await open(desktop.width, desktop.height, desktop.touch, liveTrace);
    try {
      await page.waitForSelector(".chat-msg.live .trace-head", { timeout: 5000 });
      const head = await page.evaluate(() => document.querySelector(".chat-msg.live .trace-head")?.textContent ?? "");
      expect(head).toMatch(/Thinking · \d+ s · Step 2: /);
      // The loader mark is shown (decorative) and the live reply is on the page.
      expect(await page.evaluate(() => !!document.querySelector(".chat-msg.live .trace-head .lead.spin"))).toBe(true);
      if (process.env.BOSSMAN_SCRATCH) await page.screenshot({ path: `${process.env.BOSSMAN_SCRATCH}/trace-desktop-live.png` });
    } finally {
      await page.close();
    }
  });

  it("phone: the trace fits, the summary is closed, and a step's time is hidden", async () => {
    const page = await open(phone.width, phone.height, phone.touch);
    try {
      const heads = await page.evaluate(() => [...document.querySelectorAll(".chat-msg.assistant .trace-head")].map((el) => el.textContent));
      expect(heads).toContain("Thought for 42 s · 3 steps");
      // No sideways overflow at phone width.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      // Open it: rows show, and the time column is hidden at this width.
      await page.evaluate(() => (document.querySelector(".chat-msg.assistant.has-trace .trace-head") as HTMLElement).click());
      await page.waitForSelector(".chat-msg.assistant.has-trace .step-row", { timeout: 5000 });
      const timeHidden = await page.evaluate(() => {
        const t = document.querySelector(".chat-msg.assistant.has-trace .step-row .time") as HTMLElement;
        return getComputedStyle(t).display === "none";
      });
      expect(timeHidden).toBe(true);
      // Rows are touch-sized (44 px) on a coarse pointer.
      const minH = await page.evaluate(() => Math.min(...[...document.querySelectorAll(".chat-msg.assistant.has-trace .step-row")].map((el) => Math.round((el as HTMLElement).getBoundingClientRect().height))));
      expect(minH).toBeGreaterThanOrEqual(44);
      if (process.env.BOSSMAN_SCRATCH) await page.screenshot({ path: `${process.env.BOSSMAN_SCRATCH}/trace-phone-expanded.png` });
    } finally {
      await page.close();
    }
  });
});
