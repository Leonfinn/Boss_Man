// BOS-1124 (Q5, Q6), a rendering check, not a CSS-text test: the built app is served from `apps/web/dist` to
// Chromium at 1667 x 724 (the owner's Brave figures) and the page is measured as painted.
//  - Status tags: sentence case, 12 px body font (not the code font), a coloured dot, 4.5:1 text contrast.
//  - Notifications: a "<Company> needs a decision" card shows its question as the title, the company in the
//    small line above, and a very long title is cut to its lines with the full text on hover.
// Skipped where the build or a browser is missing on a dev machine; FAILS under BOSSMAN_MERGE_CHECK or BOSSMAN_REQUIRE_BROWSER.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_POLICY } from "@boss-man/shared";
import { feedTitle } from "../src/components/FeedItem";

const DIST = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "dist");
const builtNow = () => existsSync(path.join(DIST, "index.html"));
const built = builtNow();
// Where a browser is promised, a missing build or browser fails the test: the merge gate (BOSSMAN_MERGE_CHECK) and
// the CI jobs that install one (the web-browser job and the worker-image job set BOSSMAN_REQUIRE_BROWSER=1).
// CI's plain `check` job has no browser and runs `pnpm test` without it, so there the test skips (the web-browser
// job re-runs every web test in a browser and fails on any skip). On a bare dev machine it skips too.
const strict = Boolean(process.env.BOSSMAN_MERGE_CHECK || process.env.BOSSMAN_REQUIRE_BROWSER);

const now = () => new Date().toISOString();
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", nextTicketNumber: 12, agents: [], projects: [] };
const project = { id: "p1", companyId: "c1", name: "Development", archivedAt: null, repoUrl: null, defaultBranch: "main", verifyCommand: null, deepVerifyCommand: null, landing: "merge", gitHost: null, gitApiBase: null, starred: false, ticketCostCapMicros: null, monthlyCapMicros: null };
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
  if (p === "/api/companies/c1/projects") return [project];
  if (p === "/api/risk-tiers" || p === "/api/companies/c1/objectives") return [];
  if (p === "/api/companies/c1/features") return { settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] };
  if (p === "/api/projects/p1/board") {
    const card = (id: string, n: number, title: string, systemState: string, extra: Record<string, unknown> = {}) => ({ id, title, number: n, systemState, outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: "low", size: 2, planFirst: false, plan: null, planApprovedAt: null, ...extra });
    return {
      project,
      workingAgents: 0,
      withoutTicket: [],
      columns: [
        { id: "k1", name: "Ready", systemState: "ready", wipLimit: null, tickets: [card("t2", 2, "Add the export button", "ready"), card("t3", 3, "Fix the login redirect", "ready", { risk: "high" })] },
        { id: "k2", name: "In progress", systemState: "in_progress", wipLimit: 3, tickets: [card("t4", 4, "Calmer status tags", "in_progress")] },
        { id: "k3", name: "Review", systemState: "review", wipLimit: null, tickets: [card("t1", 1, "Shorter page intros", "review", { waitingOnOwner: true })] },
        { id: "k4", name: "Blocked", systemState: "blocked", wipLimit: null, tickets: [card("t5", 5, "Wait for the merge gate fix", "blocked")] },
        { id: "k5", name: "Done", systemState: "done", wipLimit: null, tickets: [card("t6", 6, "Tidy the settings page", "done", { outcome: "done" })] },
      ],
    };
  }
  if (p === "/api/notifications/pushes") return { items: [] };
  if (p === "/api/notifications/unseen") return { count: 0 };
  if (p === "/api/runs" || p === "/api/decisions/advised" || p === "/api/decisions/with-team" || p === "/api/decisions/closed-notices") return [];
  if (p === "/api/decisions") {
    return [{ id: "d1", companyId: "c1", kind: "question", question: QUESTION, options: ["Yes, urgent only", "No, keep everything"], recommendedOption: "Yes, urgent only", tier: "owner", createdAt: now(), companyName: "Boss Man Co", agentName: "Bungle", blocks: [{ ticketId: "t1", ref: "BOS-1", title: "Calmer status tags" }], score: 10, parts: { blocking: 1, urgency: 0, age: 0, liveRun: 0 }, reasons: [], ageReason: "", dueDate: null }];
  }
  if (p === "/api/companies/c1/agents") {
    const agent = (id: string, name: string, role: string, status: string, extra: Record<string, unknown> = {}) => ({ id, name, role, title: null, template: null, instructions: null, agentKind: "agent", model: null, thinking: null, fundingSourceId: null, funding: null, fundingKind: null, paused: status === "paused", starred: false, duty: null, retiredAt: null, status, current: null, openTickets: 1, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 }, ...extra });
    return [agent("g1", "Casey", "ceo", "working", { current: { ticketId: "t1", title: "Calmer status tags" } }), agent("g2", "Bungle", "worker", "idle"), agent("g3", "Rex", "worker", "paused"), agent("g4", "Old Hand", "worker", "retired", { retiredAt: now() })];
  }
  if (p === "/api/agent-templates") return { templates: [] };
  if (p === "/api/companies/c1/models") return { runner: {}, api: [] };
  if (p === "/api/companies/c1/review-policy") return DEFAULT_REVIEW_POLICY;
  if (p === "/api/companies/c1/agent-approvals") return { approvals: "" };
  if (p === "/api/tickets/t1") {
    return { id: "t1", title: "Calmer status tags", number: 1, ref: "BOS-1", systemState: "review", outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: "bossman/t1", risk: "high", size: 2, planFirst: false, plan: null, planApprovedAt: null, waitingOnOwner: true, milestoneId: null, featureId: null, body: "Sentence-case tags with a dot, and feed items that lead with the question.", project: "Development", projectId: "p1", companyId: "c1", repoUrl: null, defaultBranch: "main", assignee: "Bungle", mergeCommit: null, lastActivityAt: now(), createdAt: now(), landing: "merge", verifyCommand: null, ownerSignoff: true, pullRequestUrl: null, pullRequestNumber: null, pullRequestNote: null, watcherAgentId: null, watchEveryMinutes: null, watchedAt: null, monitorAt: null, monitorNote: null, monitorAttempts: 0, monitorMax: 0, acceptanceCriteria: [], ownerSetup: null, noCode: false, urgent: false, stateNote: "In review.", blockedUntil: null, blockedUntilReason: null };
  }
  if (p === "/api/tickets/t1/links") return { waitsOn: [], blocks: [] };
  if (p.startsWith("/api/tickets/t1/")) return p.endsWith("/landing") ? { landing: null } : [];

  if (p === "/api/feedback/unprocessed") return {};
  if (p === "/api/health") return { role: "leader", version: "1.2.0", commit: "aaaaaaaaaaaa", colour: null, startedAt: now() };
  if (p === "/api/bluegreen") return { enabled: false };
  if (p === "/api/kill-switch") return { paused: false };
  if (p === "/api/maintenance") return { on: false, last: null };
  if (p === "/api/runner-report") return { live: [], update: null };
  if (p === "/api/release-watch") return { active: false };
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
  // The merge gate and CI run the tests before their own web build step, so build here when dist is missing
  // (the later build overwrites it). A failed build fails the test; a bare dev machine just skips.
  if (strict && !builtNow()) execFileSync("pnpm", ["build"], { cwd: path.dirname(DIST), stdio: "pipe", timeout: 240_000 });
  server =createServer((req, res) => {
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

describe.skipIf(!built && !strict)("BOS-1124 tags and feed items as painted at 1667 x 724", () => {
  // One browser for the whole describe, started in beforeAll (BOS-1790): on a cold GitHub runner the first test paid
  // for Chromium's start-up inside its 60 s and timed out. The tests still time only their own page work.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let shared: any = null;
  beforeAll(async () => {
    shared = await launch();
  }, 180_000);
  afterAll(async () => {
    await shared?.close();
  });
  it("tags are sentence case, 12 px body font with a dot and 4.5:1; the feed leads with the question and cuts long titles", async () => {
    expect(builtNow(), "apps/web/dist is missing and the build did not make it").toBe(true);
    const browser = shared;
    if (!browser) {
      expect(strict, "no browser could be launched; the merge gate and CI must supply one").toBe(false);
      return;
    }
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
      /* the shared browser is closed in afterAll */
    }
  }, 60_000);

  // One test per width (BOS-1708): the three widths walked in one test shared a single 120 s budget, which GitHub's
  // slower runners overran (18 page loads, each with a fixed sleep). Each width has its own budget now.
  for (const [w, h] of [[1550, 1611], [1667, 724], [390, 844]] as const) it(`the screens open at ${w} px wide without sideways scrolling (screenshots go to BOSSMAN_SCRATCH)`, async () => {
    expect(builtNow(), "apps/web/dist is missing and the build did not make it").toBe(true);
    const browser = shared;
    if (!browser) {
      expect(strict, "no browser could be launched; the merge gate and CI must supply one").toBe(false);
      return;
    }
    const dir = process.env.BOSSMAN_SCRATCH;
    try {
      {
        for (const route of ["board", "decisions", "agents", "notifications", "dashboard", "ticket"]) {
          const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
          await page.goto(`${base}/#/${route === "dashboard" ? "" : route === "ticket" ? "tickets/t1" : route}`, { waitUntil: "networkidle" });
          // Wait for the app to have drawn something (a route's own content or the error page), then two frames, so a
          // render error has shown before it is read; no fixed sleep.
          await page.waitForFunction(() => (document.getElementById("root")?.textContent ?? "").trim().length > 0, undefined, { timeout: 15_000 });
          await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
          const failed = await page.evaluate(() => {
            const t = document.body.textContent ?? "";
            return t.includes("This page hit an error") ? t.slice(t.indexOf("This page hit an error"), t.indexOf("This page hit an error") + 200) : "";
          });
          expect(failed, `${route} at ${w}px shows the error page (the stand-in data is incomplete)`).toBe("");
          // Name the element that sticks out furthest, so a failure says where.
          const wide = await page.evaluate(() => {
            if (document.documentElement.scrollWidth <= window.innerWidth + 1) return "";
            const out = [...document.querySelectorAll("body *")].map((el) => ({ el, r: el.getBoundingClientRect().right })).sort((a, b) => b.r - a.r)[0];
            return out ? `${out.el.tagName}.${String(out.el.getAttribute("class"))} right edge ${Math.round(out.r)}px: ${(out.el.textContent ?? "").slice(0, 60)}` : "unknown";
          });
          expect(wide, `${route} at ${w}px scrolls sideways`).toBe("");
          if (dir) {
            mkdirSync(dir, { recursive: true });
            // The phone shot is the whole page, so Recent activity (below the charts) is in view.
            await page.screenshot({ path: path.join(dir, `bos-1124-${route}-${w}.png`), fullPage: w < 500 }).catch(() => undefined);
          }
          await page.close();
        }
      }
    } finally {
      /* the shared browser is closed in afterAll */
    }
  }, 120_000);
});
