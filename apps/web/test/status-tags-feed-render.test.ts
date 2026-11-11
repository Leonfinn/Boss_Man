// BOS-1124 (Q5, Q6), a rendering check, not a CSS-text test: the built app is served from `apps/web/dist` to
// Chromium at 1667 x 724 (the owner's Brave figures) and the page is measured as painted.
//  - Status tags: sentence case, 12 px body font (not the code font), a coloured dot, 4.5:1 text contrast.
//  - Notifications: a "<Company> needs a decision" card shows its question as the title, the company in the
//    small line above, and a very long title is cut to its lines with the full text on hover.
// Skipped, not failed, where the build or a browser is missing (the gate builds the web app first).
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { feedTitle } from "../src/components/FeedItem";

const DIST = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "dist");
const built = existsSync(path.join(DIST, "index.html"));

const now = () => new Date().toISOString();
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", nextTicketNumber: 12, agents: [], projects: [] };
const QUESTION = "Should the phone push only carry urgent cards from now on?";
const LONG = "A very long event title that keeps going ".repeat(12).trim();
const notice = (id: string, title: string, body: string | null) => ({ id, companyId: "c1", company: "Boss Man Co", agentId: null, requested: "ask", level: "ask", demotedBy: null, title, body, link: "#/decisions", pushedAt: null, pushError: null, readAt: null, createdAt: now() });

function answer(p: string): unknown {
  if (p === "/api/setup") return { needsSetup: false };
  if (p === "/api/me") return { username: "owner" };
  if (p === "/api/setup-progress") return { dismissed: true };
  if (p === "/api/companies") return [company];
  if (p === "/api/notifications") return { items: [notice("n1", "Boss Man Co needs a decision", QUESTION), notice("n2", LONG, null)], unread: 2 };
  if (p === "/api/companies/c1/dashboard") {
    const days = Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10), running: 0, succeeded: i % 3, failed: i % 5 === 0 ? 1 : 0, other: 0, created: 1, done: i % 2 }));
    return {
      agents: [],
      stats: { agents: 0, running: 0, paused: 0, inProgress: 1, inReview: 1, open: 2, blocked: 1, decisionsWaiting: 1, monthCostMicros: 0, monthSubscriptionTokens: { input: 0, output: 0 }, monthSubscriptionRuns: 0, monthSubscriptionUnrecorded: 0 },
      runsByDay: days,
      ticketsByDay: days,
      recentTickets: [{ id: "t1", title: "Calmer status tags", state: "review", outcome: null, assignee: null, lastActivityAt: now() }],
      recentActivity: [
        { id: "a1", title: "Boss Man Co needs a decision", body: QUESTION, link: "#/decisions", level: "ask", agent: null, createdAt: now() },
        { id: "a2", title: LONG, body: null, link: "#/decisions", level: "note", agent: null, createdAt: now() },
      ],
    };
  }
  if (p === "/api/notifications/pushes") return { items: [] };
  if (p === "/api/notifications/unseen") return { count: 0 };
  if (p === "/api/runs" || p === "/api/decisions" || p === "/api/decisions/advised" || p === "/api/decisions/with-team" || p === "/api/decisions/closed-notices") return [];
  if (p === "/api/feedback/unprocessed") return {};
  if (p === "/api/health") return { role: "leader", version: "1.2.0", commit: "aaaaaaaaaaaa", colour: null, startedAt: now() };
  if (p === "/api/bluegreen") return { enabled: false };
  if (p === "/api/kill-switch") return { paused: false };
  if (p === "/api/maintenance") return { on: false, last: null };
  if (p === "/api/runner-report") return { live: [], update: null };
  if (p === "/api/self-deploy") return { enabled: false };
  if (p === "/api/devices" || p === "/api/funding-sources") return [];
  if (p === "/api/notification-settings") return { quietHours: null, agentHourlyCap: 10, ntfy: null };
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

/** Run in the page: every tag's painted text, font, dot and contrast against its own background. */
function measureTags() {
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
  };
  const parse = (v: string) => (v.match(/[\d.]+/g) ?? []).map(Number);
  return [...document.querySelectorAll(".tag")].map((el) => {
    const cs = getComputedStyle(el);
    const dot = getComputedStyle(el, "::before");
    const a = lum(parse(cs.color));
    const b = lum(parse(cs.backgroundColor));
    return {
      text: (el.textContent ?? "").trim(),
      fontSize: cs.fontSize,
      font: cs.fontFamily,
      transform: cs.textTransform,
      dotWidth: dot.width,
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    };
  });
}

describe("feedTitle", () => {
  it("uses the question for a decision card, keeps other titles, and ignores an empty body", () => {
    expect(feedTitle("Boss Man Co needs a decision", `${QUESTION}\nmore`)).toBe(QUESTION);
    expect(feedTitle("Run failed", QUESTION)).toBe("Run failed");
    expect(feedTitle("Boss Man Co needs a decision", "  ")).toBe("Boss Man Co needs a decision");
    expect(feedTitle("Boss Man Co needs a decision", null)).toBe("Boss Man Co needs a decision");
  });
});

describe.skipIf(!built)("BOS-1124 tags and feed items as painted at 1667 x 724", () => {
  it("tags are sentence case, 12 px body font with a dot and 4.5:1; the feed leads with the question and cuts long titles", async () => {
    const browser = await launch();
    if (!browser) return;
    try {
      const page = await browser.newPage({ viewport: { width: 1667, height: 724 }, deviceScaleFactor: 1 });
      await page.goto(`${base}/#/notifications`, { waitUntil: "networkidle" });
      await page.waitForSelector(".feed-title", { timeout: 15_000 });

      const tags = await page.evaluate(measureTags);
      expect(tags.length).toBeGreaterThan(1);
      for (const t of tags) {
        expect(t.fontSize, JSON.stringify(t)).toBe("12px");
        expect(t.transform, JSON.stringify(t)).toBe("none");
        expect(t.font, JSON.stringify(t)).not.toMatch(/mono/i);
        expect(t.dotWidth, JSON.stringify(t)).toBe("6px");
        expect(t.ratio, JSON.stringify(t)).toBeGreaterThanOrEqual(4.5);
      }

      const feed = await page.evaluate(() =>
        [...document.querySelectorAll(".feed-item")].map((el) => {
          const t = el.querySelector(".feed-title") as HTMLElement;
          return { title: t.textContent, hover: t.getAttribute("title"), small: (el.querySelector(".feed-small")?.textContent ?? ""), cut: t.scrollHeight > t.clientHeight + 1 };
        }),
      );
      expect(feed[0]).toMatchObject({ title: QUESTION, hover: QUESTION });
      expect(feed[0]!.small).toContain("Boss Man Co");
      expect(feed[0]!.title).not.toContain("needs a decision");
      expect(feed[1]).toMatchObject({ title: LONG, hover: LONG, cut: true });

      const dir = process.env.BOSSMAN_SCRATCH;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, "bos-1124-notifications-after.png") }).catch(() => undefined);
      }
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("the screens open at 1550, 1667 x 724 and a phone width without sideways scrolling (screenshots go to BOSSMAN_SCRATCH)", async () => {
    const browser = await launch();
    if (!browser) return;
    const dir = process.env.BOSSMAN_SCRATCH;
    try {
      for (const [w, h] of [[1550, 1611], [1667, 724], [390, 844]] as const) {
        for (const route of ["board", "decisions", "agents", "notifications", "dashboard"]) {
          const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
          await page.goto(`${base}/#/${route === "dashboard" ? "" : route}`, { waitUntil: "networkidle" });
          const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
          expect(wide, `${route} at ${w}px scrolls sideways`).toBe(false);
          if (dir) {
            mkdirSync(dir, { recursive: true });
            await page.screenshot({ path: path.join(dir, `bos-1124-${route}-${w}.png`) }).catch(() => undefined);
          }
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
});
