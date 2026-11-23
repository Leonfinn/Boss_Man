// @vitest-environment node
// A rendering check for the page intros (P7, BOS-1278): the built web app is served from `apps/web/dist` to
// Chromium with made-up data, and each of the four places shows its one-sentence lead with the rest behind a
// closed "More about this" fold (Features keeps its "How the portal works" toggle), open on a press, inside the
// window. Run at the owner's two recorded screens: Brave 1667×724 touch and Safari 1550×1611. Screenshots of every
// place, closed and open, go to BOSSMAN_SCRATCH. Skipped, not failed, where the build or a browser is missing.
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
const agent = { companyId: "c1", role: "worker", agentKind: "claude", model: "opus", fundingSourceId: null, paused: false, starred: false, duty: "Builds the pages", instructions: "", funding: null, fundingKind: null, retiredAt: null, status: "idle", current: null, openTickets: 0, pa: null, month: { costMicros: 0, runs: 0, tokens: 0 }, name: "Bungle", title: "Web Developer" };
const feature = {
  id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Dark mode", description: null, status: "planned", effort: 2, rank: null, horizon: null,
  driverScores: {}, milestoneId: null, objectiveId: null, portalVisible: true, keepOffPortal: false, publicSummary: "A dark theme you can switch on.",
  publicTitle: null, showPublicly: false, createdAt: now(), updatedAt: now(), releasedAt: null, demand: 3, insightCount: 2, customerCount: 2, value: 4.5,
  demandPart: 1.5, priority: 6.8, tickets: { total: 0, done: 0, items: [] }, portal: { onPortal: true, reason: null },
};

function answer(p: string): unknown {
  if (p === "/api/setup") return { needsSetup: false };
  if (p === "/api/me") return { username: "owner" };
  if (p === "/api/setup-progress") return { dismissed: true };
  if (p === "/api/companies") return [company];
  if (p === "/api/notifications") return { items: [], unread: 0 };
  if (["/api/runs", "/api/decisions", "/api/decisions/advised", "/api/decisions/with-team", "/api/decisions/closed-notices", "/api/devices", "/api/funding-sources", "/api/phone-pushes"].includes(p)) return [];
  if (p === "/api/agent-templates") return { templates: [] };
  if (p === "/api/health") return { role: "leader", version: "1.2.0", commit: "aaaaaaaaaaaa", colour: null, startedAt: now() };
  if (p === "/api/bluegreen" || p === "/api/self-deploy") return { enabled: false };
  if (p === "/api/kill-switch") return { paused: false };
  if (p === "/api/maintenance") return { on: false, last: null };
  if (p === "/api/runner-report") return { live: [], update: null };
  if (p === "/api/companies/c1/agents") return [agent];
  if (p === "/api/companies/c1/projects") return [];
  // Settings → Team and CEO lists the chapters (an array) beside the approvals setting.
  if (p === "/api/companies/c1/chapters") return [];
  if (p === "/api/companies/c1/models") return { runner: {}, api: [] };
  if (p === "/api/companies/c1/review-policy") return { levels: {} };
  if (p === "/api/notifications/settings") return { quiet: false, start: "22:00", end: "07:00", phoneAddress: null };
  if (p === "/api/companies/c1/features") return { settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [feature] };
  if (p === "/api/companies/c1/feedback-settings") return { demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] };
  // Settings → Server and runner shows every panel on one page; each one needs a shape it can read.
  if (p === "/api/companies/c1/runner") return { registered: false };
  if (p === "/api/self-deploy") return { enabled: false, pending: false, status: null, available: null };
  if (p === "/api/run-limits") return { instance: 3, company: 2, background: 1, defaults: { instance: 3, company: 2, background: 1 } };
  if (p === "/api/wip-limits") return { agent: null, company: null, defaultAgent: 2 };
  if (p === "/api/settings/check-queue") return { mode: "legacy", slots: 1, maxSlots: 3, defaultSlots: 1, runnersTooOld: [] };
  if (p === "/api/host-facts") return { hostName: null, reportedAt: null, ownerFacts: [], facts: {} };
  if (p === "/api/netguard-allow") return { report: { mode: null, entries: [], lineCanGo: false, automatic: [], env: null, warnings: [] } };
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

/** The four places, with the lead the owner approved and a phrase only the fold holds. */
const PLACES = [
  {
    name: "team",
    hash: "#/settings/c1/team",
    ready: 'select#ceo-approvals',
    lead: "Choose whether the CEO's changes to an agent's instructions wait for you.",
    held: "Hires and model changes always wait for you",
    // The shared fold keeps one label; BOS-1257's changes to "Less" once open.
    button: "More about this",
    reopened: "More about this",
  },
  {
    name: "server",
    hash: "#/settings/c1/updates",
    ready: "#stop-all-h",
    lead: "Stops every company from starting new agent runs until you press Resume.",
    held: "Runs already going are not cut off",
    button: "More about this",
    reopened: "More about this",
  },
  {
    name: "notifications",
    hash: "#/settings/c1/notifications",
    ready: "#notify-settings-h",
    lead: "Choose how loudly Boss Man tells you about things, and whether it reaches your phone.",
    held: "In quiet hours, each notification is one step quieter",
    button: "More about this",
    reopened: "More about this",
  },
  {
    name: "features",
    hash: "#/features/c1",
    ready: "header.page-head",
    lead: "New features show on your feedback portal unless they look like security work.",
    held: "Visitors only see a feature once it has a public summary",
    button: "How the portal works",
    reopened: "Less",
  },
];

const SIZES = [
  { name: "brave-1667x724", width: 1667, height: 724, touch: true },
  { name: "safari-1550x1611", width: 1550, height: 1611, touch: false },
];

describe.skipIf(!built)("BOS-1278 page intros in a real browser", () => {
  for (const s of SIZES) {
    it(`${s.name}: each place shows its lead and folds the rest away until pressed`, async () => {
      const browser = await launch();
      if (!browser) return;
      try {
        const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, hasTouch: s.touch, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        for (const place of PLACES) {
          await page.goto(`${base}/${place.hash}`, { waitUntil: "networkidle" });
          await page.waitForSelector(place.ready, { timeout: 15_000 }).catch(async (e: Error) => {
            await saveShot(`bos-1278-failed-${place.name}-${s.name}.png`, page);
            throw new Error(`${e.message}\nPage text: ${(await page.evaluate(() => document.body.innerText)).slice(0, 400)}`);
          });
          const body = await page.evaluate(() => document.body.innerText);
          expect(body, `${place.name}: the lead is on the page`).toContain(place.lead);
          expect(body, `${place.name}: the fold is closed at first`).not.toContain(place.held);

          const button = page.getByRole("button", { name: place.button, exact: true }).first();
          expect(await button.getAttribute("aria-expanded"), `${place.name}: closed`).toBe("false");
          const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
          expect(overflow.sw, `${place.name}: no sideways scroll closed ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.cw);
          await saveShot(`bos-1278-${place.name}-${s.name}-closed.png`, page);

          await button.click();
          // BOS-1257's toggle changes its word to "Less" once open; the shared fold keeps its label.
          const opened = page.getByRole("button", { name: place.reopened, exact: true }).first();
          expect(await opened.getAttribute("aria-expanded"), `${place.name}: open`).toBe("true");
          expect(await page.evaluate(() => document.body.innerText), `${place.name}: the rest is in the page when open`).toContain(place.held);
          const open = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
          expect(open.sw, `${place.name}: no sideways scroll open ${JSON.stringify(open)}`).toBeLessThanOrEqual(open.cw);
          await saveShot(`bos-1278-${place.name}-${s.name}-open.png`, page);

          // Features has only BOS-1257's one toggle there; the other three have the shared one.
          if (place.name === "features") expect(await page.getByRole("button", { name: "More about this" }).count()).toBe(0);
          else expect(await page.getByRole("button", { name: "How the portal works" }).count()).toBe(0);
        }
        await ctx.close();
      } finally {
        await browser.close();
      }
    }, 120_000);
  }
});
