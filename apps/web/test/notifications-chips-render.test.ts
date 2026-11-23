// @vitest-environment node
// Real-browser check of the Notifications chip row (BOS-1277): the real app is mounted (Vite in-process) with
// made-up notices, at the owner's three sizes (Safari 1550, Brave 1667×724 touch, phone 390). It measures what jsdom
// cannot: the page never scrolls sideways, chips and "?" are 44 px on touch and phones, and on a phone the chip row
// scrolls inside itself. Screenshots go to BOSSMAN_SCRATCH. Skipped on a dev machine with no browser or Vite;
// at the merge gate a missing browser fails (CLAUDE.md: no quiet skips there).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi, type Browser, type Server } from "./real-page";

const now = new Date().toISOString();
const notice = (n: number, level: string, companyId: string | null, company: string | null) => ({
  id: `n${n}`, companyId, company, agentId: null, requested: level, level, demotedBy: null,
  title: `Made-up notice number ${n}`, body: null, link: "#/decisions", pushedAt: null, pushError: null, readAt: null, createdAt: now,
});
const items = [
  notice(1, "ask", "c1", "Boss Man Co"),
  notice(2, "page", "c1", "Boss Man Co"),
  notice(3, "flag", "c2", "Second Company With A Rather Long Name"),
  notice(4, "note", null, null),
];
const counts = { level: { ask: 2, page: 1, flag: 1, note: 120 }, company: { c1: 3, c2: 1, none: 1 } };
const api: Record<string, unknown> = {
  ...API,
  "/api/companies": [
    { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", agents: [] },
    { id: "c2", name: "Second Company With A Rather Long Name", mission: null, paused: false, ticketPrefix: "SEC", agents: [] },
  ],
  "/api/notifications": { items, unread: 4, counts },
};

const browser: Browser | null = await launch();
const server: Server | null = browser ? await startVite() : null;
if ((!browser || !server) && process.env.BOSSMAN_MERGE_CHECK) {
  throw new Error("notifications-chips-render: no browser or Vite at the merge gate; this test must run there");
}
beforeAll(() => {
  if (process.env.BOSSMAN_SCRATCH) mkdirSync(process.env.BOSSMAN_SCRATCH, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const SIZES = [
  { name: "desktop-1550", width: 1550, height: 1611, touch: false },
  { name: "foldable-1667x724", width: 1667, height: 724, touch: true },
  { name: "phone-390", width: 390, height: 800, touch: true },
];

describe.skipIf(!browser || !server)("Notifications chips in a real browser", () => {
  for (const size of SIZES) {
    it(`lays out right at ${size.name}`, async () => {
      const page = await browser!.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, hasTouch: size.touch, isMobile: size.touch && size.width < 641 });
      await stubApi(page, api);
      await page.goto(`${server!.resolvedUrls.local[0]}#/notifications`, { waitUntil: "networkidle" });
      await page.waitForSelector(".nf-bar .chip.nf", { timeout: 15_000 });
      const r = await page.evaluate(() => {
        const bar = document.querySelector(".nf-bar") as HTMLElement;
        const chips = Array.from(bar.querySelectorAll<HTMLElement>(".chip.nf, .nf-help")).map((e) => e.getBoundingClientRect().height);
        return {
          docScroll: document.documentElement.scrollWidth,
          docClient: document.documentElement.clientWidth,
          barScroll: bar.scrollWidth,
          barClient: bar.clientWidth,
          minChip: Math.min(...chips),
          count: chips.length,
        };
      });
      // "Recent phone pushes" moved to Settings → Notifications (BOS-2327): measure its summary there.
      await page.goto(`${server!.resolvedUrls.local[0]}#/settings/c1/notifications`, { waitUntil: "networkidle" });
      await page.waitForSelector("details.pushes > summary", { timeout: 15_000 });
      const summaryH = await page.evaluate(() => (document.querySelector("details.pushes > summary") as HTMLElement).getBoundingClientRect().height);
      if (process.env.BOSSMAN_SCRATCH) await page.screenshot({ path: path.join(process.env.BOSSMAN_SCRATCH, `notifications-chips-${size.name}.png`) });
      await page.close();
      expect(r.count).toBeGreaterThanOrEqual(9);
      expect(r.docScroll).toBeLessThanOrEqual(r.docClient);
      if (size.touch) {
        expect(r.minChip).toBeGreaterThanOrEqual(44);
        expect(summaryH).toBeGreaterThanOrEqual(44);
      } else {
        expect(r.minChip).toBeGreaterThanOrEqual(28);
      }
      // On a phone the row stays one line and scrolls inside itself; wider, it wraps and never needs to.
      if (size.width < 641) expect(r.barScroll).toBeGreaterThan(r.barClient);
    });
  }
});
