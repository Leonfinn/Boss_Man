// @vitest-environment node
// Real-browser check of the Skills page's "N need attention" line and switch (BOS-2518), the way BOS-1078's
// merge-queue test does it: the real app is mounted (Vite in-process) with 40 made-up skills, one with a very
// long name, at the owner's three sizes (Safari 1550, Brave 1667×724 touch, phone 390). It measures what jsdom
// cannot: the count and switch stay one line tall where room allows, never overlap, and never run off the list.
// Skipped on a dev machine with no browser or Vite; at the merge gate a missing browser fails (CLAUDE.md).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi, type Browser, type Server } from "./real-page";
import { SKILLS_CSV_HEAD } from "../src/pages/Skills";

const agents = [
  { id: "a1", name: "Kate - Claude", role: "worker", status: "idle", agentKind: "claude", companyId: "c1", model: null, fundingSourceId: null, paused: false, starred: false, duty: null },
  { id: "a2", name: "Cody - Codex", role: "worker", status: "idle", agentKind: "codex", companyId: "c1", model: null, fundingSourceId: null, paused: false, starred: false, duty: null },
];
const longName = "a-very-long-skill-name-that-keeps-going-and-going-well-past-the-width-of-the-list";
type Row = { id: string; name: string; hasInstructions?: boolean; instructionsUnreadable?: boolean; agents: Array<{ id: string; name: string }> };
const make = (i: number): Row => {
  const base = { id: `s${i}`, name: i === 0 ? longName : `made-up-skill-${i}`, description: `Made-up skill number ${i}, used to check the layout.`, source: "written", sourceUrl: null, sourceRef: null, pack: null, packUrl: null, sizeBytes: 1200, fileCount: 1, updatedAt: new Date().toISOString(), agents: [{ id: "a1", name: "Kate - Claude" }] };
  // Spread the reasons over the 40: some healthy, some each kind of problem.
  if (i === 0) return { ...base, hasInstructions: false };
  if (i % 7 === 0) return { ...base, hasInstructions: true, agents: [] };
  if (i % 11 === 0) return { ...base, hasInstructions: true, instructionsUnreadable: true };
  if (i % 5 === 0) return { ...base, hasInstructions: true, agents: [{ id: "a2", name: "Cody - Codex" }] };
  return { ...base, hasInstructions: true };
};
const skills: Row[] = Array.from({ length: 40 }, (_, i) => make(i));
const updates: Record<string, unknown> = {};
for (let i = 1; i < 40; i += 4) updates[`s${i}`] = { status: "newer", commit: "abc1234", date: "2026-11-20T00:00:00Z" };
for (let i = 2; i < 40; i += 9) updates[`s${i}`] = { status: "error", reason: "GitHub was busy." };
const needing = skills.filter((s) => s.hasInstructions === false || s.instructionsUnreadable || updates[s.id] || s.agents.length === 0 || s.agents.every((a) => a.id !== "a1")).length;

const api: Record<string, unknown> = {
  ...API,
  "/api/companies": [{ id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOS", agents }],
  "/api/companies/c1/skills": skills,
  "/api/companies/c1/skills/updates": updates,
  "/api/companies/c1/skills/elsewhere": [],
  "/api/companies/c1/skill-proposals": [],
};

const browser: Browser | null = await launch();
const server: Server | null = browser ? await startVite() : null;
if ((!browser || !server) && process.env.BOSSMAN_MERGE_CHECK) {
  throw new Error("skills-attention-render: no browser or Vite at the merge gate; this test must run there");
}
beforeAll(() => {
  if (process.env.BOSSMAN_SCRATCH) mkdirSync(process.env.BOSSMAN_SCRATCH, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const SIZES = [
  { name: "safari-1550", width: 1550, height: 1611, touch: false },
  { name: "brave-foldable-1667x724", width: 1667, height: 724, touch: true },
  { name: "phone-390", width: 390, height: 844, touch: true },
];

describe.skipIf(!browser || !server)("Skills needs-attention line in a real browser (BOS-2518)", () => {
  for (const size of SIZES) {
    it(`keeps the count, switch, Download CSV and tags inside the list at ${size.name}`, async () => {
      const page = await browser!.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, hasTouch: size.touch, isMobile: size.touch && size.width < 641 });
      try {
        await stubApi(page, api);
        await page.goto(`${server!.resolvedUrls.local[0]}#/skills`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".wiki-list .skills-attention", { timeout: 40_000 });
        const count = await page.evaluate(() =>
          [...document.querySelectorAll(".skills-attention-count")].map((e) => (e as HTMLElement).innerText)[0],
        );
        expect(count).toBe(`${needing} need attention`);

        const r = await page.evaluate(() => {
          const box = (e: Element | null) => {
            const b = e?.getBoundingClientRect();
            return b ? { l: b.left, r: b.right, y: b.top, y2: b.bottom, w: b.width, h: b.height } : null;
          };
          const list = document.querySelector(".wiki-list") as HTMLElement;
          const row = document.querySelector(".wiki-list .skills-attention") as HTMLElement;
          const count = document.querySelector(".skills-attention-count") as HTMLElement;
          const sw = row.querySelector('[role="switch"]') as HTMLElement;
          const label = [...row.querySelectorAll("span.muted")][0] as HTMLElement;
          const csv = row.querySelector("button.btn.small") as HTMLElement;
          return {
            docScroll: document.documentElement.scrollWidth,
            docClient: document.documentElement.clientWidth,
            listScroll: list.scrollWidth,
            listClient: list.clientWidth,
            list: box(list),
            row: box(row),
            count: box(count),
            sw: box(sw),
            label: box(label),
            csv: box(csv),
            csvText: csv?.innerText,
            rowScroll: row.scrollWidth - row.clientWidth,
          };
        });

        expect(r.list).not.toBeNull();
        for (const part of [r.count, r.sw, r.label]) {
          expect(part).not.toBeNull();
          // Inside the list's width, never running off it.
          expect(part!.l).toBeGreaterThanOrEqual(r.list!.l - 0.5);
          expect(part!.r).toBeLessThanOrEqual(r.list!.r + 0.5);
          // The count/switch/label never overlap each other.
          for (const other of [r.count, r.sw, r.label]) {
            if (other === part) continue;
            const overlapX = Math.min(part!.r, other!.r) - Math.max(part!.l, other!.l);
            const overlapY = Math.min(part!.y2, other!.y2) - Math.max(part!.y, other!.y);
            expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(1);
          }
        }
        // BOS-2544: the Download CSV sits beside the switch, inside the list, never over the label or count.
        expect(r.csvText).toBe("Download CSV");
        expect(r.csv).not.toBeNull();
        expect(r.csv!.l).toBeGreaterThanOrEqual(r.list!.l - 0.5);
        expect(r.csv!.r).toBeLessThanOrEqual(r.list!.r + 0.5);
        for (const other of [r.count, r.label]) {
          const overlapX = Math.min(r.csv!.r, other!.r) - Math.max(r.csv!.l, other!.l);
          const overlapY = Math.min(r.csv!.y2, other!.y2) - Math.max(r.csv!.y, other!.y);
          expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(1);
        }
        expect(r.rowScroll).toBeLessThanOrEqual(1);
        // The page never scrolls sideways.
        expect(r.docScroll).toBeLessThanOrEqual(r.docClient);
        // Wider screens have room for the whole line: count and switch share one row (their boxes overlap
        // vertically, centred). On a phone the label may wrap below, but the count and switch still do not.
        if (size.width >= 641) {
          const vOverlap = Math.min(r.count!.y2, r.sw!.y2) - Math.max(r.count!.y, r.sw!.y);
          expect(vOverlap).toBeGreaterThan(Math.min(r.count!.h, r.sw!.h) / 2);
        }

        if (process.env.BOSSMAN_SCRATCH) await page.screenshot({ path: path.join(process.env.BOSSMAN_SCRATCH, `skills-attention-${size.name}.png`), fullPage: true });
      } finally {
        await page.close();
      }
    }, 60_000);

    // BOS-2544: the Download CSV beside the switch saves the skills the list shows, from the page's own data.
    it(`Download CSV saves the skills shown, following the switch at ${size.name}`, async () => {
      const page = await browser!.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, hasTouch: size.touch, isMobile: size.touch && size.width < 641 });
      try {
        await stubApi(page, api);
        await page.goto(`${server!.resolvedUrls.local[0]}#/skills`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".wiki-list .skills-attention", { timeout: 40_000 });
        // Capture what the page hands the browser: its file name, and the blob's text (read at once, before the page frees the URL).
        await page.evaluate(() => {
          (window as unknown as { __dl: { name: string; text: string } | null }).__dl = null;
          HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
            const url = this.href;
            const name = this.download;
            void fetch(url)
              .then((r) => r.text())
              .then((text) => ((window as unknown as { __dl: { name: string; text: string } | null }).__dl = { name, text }));
          };
        });
        await page.click(".skills-attention button.btn.small");
        await page.waitForFunction(() => (window as unknown as { __dl: unknown }).__dl !== null, null, { timeout: 10_000 });
        const saved = await page.evaluate(() => (window as unknown as { __dl: { name: string; text: string } }).__dl);
        expect(saved.name).toMatch(/^skills-\d{4}-\d{2}-\d{2}\.csv$/);
        const lines = saved.text.split("\r\n");
        expect(lines[0]).toBe(SKILLS_CSV_HEAD.join(","));
        // The switch is off, so it holds every skill the page shows: 40 made-up ones.
        expect(lines.slice(1).filter(Boolean)).toHaveLength(40);
        // With the switch on, the CSV narrows to the skills needing attention, as the count says.
        await page.click('.skills-attention [role="switch"]');
        await page.evaluate(() => ((window as unknown as { __dl: unknown }).__dl = null));
        await page.click(".skills-attention button.btn.small");
        await page.waitForFunction(() => (window as unknown as { __dl: unknown }).__dl !== null, null, { timeout: 10_000 });
        const narrowed = await page.evaluate(() => (window as unknown as { __dl: { name: string; text: string } }).__dl);
        expect(narrowed.text.split("\r\n").slice(1).filter(Boolean)).toHaveLength(needing);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
