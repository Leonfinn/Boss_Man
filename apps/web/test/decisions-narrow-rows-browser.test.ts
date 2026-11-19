import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// BOS-1825: the Decisions page's "Left your list recently" rows and re-check strips on a phone, in a real
// browser. Each row stacks (title, then time and reason, then link); the time and the link stay on one line;
// a long title is cut to 2 lines; no part is a thin column. Waits are on elements, never fixed sleeps.
// Skipped, not failed, where no browser or Vite is installed (the runner and CI have both).

const browser = await launch();
const server = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const now = Date.now();
const longTitle = "Deploy Boss Man 7704a0c6 -> d969ab7c? 113 files changed, 1 database migration, runner code changed, and the deployer script was updated as well, so please confirm before it goes out tonight";
const recheck = {
  id: "d-recheck", companyId: "c1", kind: "choice", question: "Sign off the BOS-1820 plan?", options: ["Yes", "No"], recommendedOption: "Yes", tier: "owner",
  createdAt: new Date(now - 3_600_000).toISOString(), companyName: "Boss Man Co", agentName: "CEO", blocks: [], about: [], projects: [], score: 10,
  parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 }, reasons: [], ageReason: "", dueDate: null,
  staleAt: new Date(now - 600_000).toISOString(), staleReason: "the owner answered a related card", waiting: "Being re-checked by CEO",
  rechecking: { by: "CEO", stage: "author", backBy: new Date(now + 3_000_000).toISOString(), hidden: true },
};
const notice = (id: string, question: string, withNewer: boolean) => ({
  id, companyId: "c1", question, context: {},
  notice: {
    why: withNewer ? "newer" : "withdrawn", text: "Withdrawn by the CEO: a newer card covers it. You don't need to do anything for this card.",
    at: new Date(now - 60_000).toISOString(), until: new Date(now + 3_600_000).toISOString(),
    ...(withNewer ? { newer: { decisionId: "d-new", label: "Deploy the newer build" } } : {}),
  },
});
const api = {
  ...API,
  "/api/decisions": [recheck],
  "/api/decisions/tally": { open: 0, waiting: 1 },
  "/api/decisions/closed-notices": [notice("n1", longTitle, true), notice("n2", "Short card", false)],
};

const SIZES = [
  { name: "phone-portrait-724", width: 724, height: 784, ratio: 3, touch: true },
  { name: "phone-landscape-1667", width: 1667, height: 724, ratio: 3, touch: true },
  { name: "phone-390", width: 390, height: 844, ratio: 3, touch: true },
  { name: "desktop-1550", width: 1550, height: 900, ratio: 1, touch: false },
];

describe.skipIf(!browser || !server)("BOS-1825 narrow rows on the Decisions page in a real browser", () => {
  for (const s of SIZES) {
    it(`${s.name}`, async () => {
      const page = await browser!.newPage({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.ratio, hasTouch: s.touch, isMobile: s.touch });
      try {
        await stubApi(page, api);
        await page.goto(`${server!.resolvedUrls.local[0]}#/decisions`, { waitUntil: "networkidle" });
        await page.waitForSelector("[data-testid=left-your-list] li", { timeout: 15_000 });
        await page.waitForSelector("[data-testid=recheck-lines] li", { timeout: 15_000 });
        const dir = process.env.BOSSMAN_SCRATCH;
        if (dir) await page.screenshot({ path: `${dir}/bos-1825-${s.name}.png`, fullPage: true });
        const m = await page.evaluate(() => {
          const box = (e: Element) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top }; };
          const rows = [...document.querySelectorAll("[data-testid=left-your-list] li, [data-testid=recheck-lines] li")];
          return {
            sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
            rows: rows.map((li) => ({
              title: box(li.querySelector(".strip-title")!),
              titleLine: parseFloat(getComputedStyle(li.querySelector(".strip-title")!).lineHeight) || 20,
              when: li.querySelector(".strip-when") ? box(li.querySelector(".strip-when")!) : null,
              link: li.querySelector("a") ? box(li.querySelector("a")!) : null,
              lineH: parseFloat(getComputedStyle(li).lineHeight) || 20,
              parts: [...li.children].map((c) => box(c).w),
            })),
          };
        });
        expect(m.sw, JSON.stringify(m)).toBeLessThanOrEqual(m.cw);
        const narrow = s.width <= 900;
        for (const r of m.rows) {
          // No part is a thin column.
          for (const w of r.parts) expect(w, JSON.stringify(r)).toBeGreaterThanOrEqual(narrow ? 120 : 1);
          if (r.when) expect(r.when.h, "time on one line").toBeLessThan(r.lineH * 1.6);
          if (r.link) expect(r.link.h, "link on one line").toBeLessThan(r.lineH * 1.6);
          if (narrow) {
            // Stacked: title above time above link, and the title is at most 2 lines.
            expect(r.title.h).toBeLessThanOrEqual(r.titleLine * 2 + 2);
            if (r.when) expect(r.when.top).toBeGreaterThanOrEqual(r.title.top + r.title.h - 1);
            if (r.when && r.link) expect(r.link.top).toBeGreaterThanOrEqual(r.when.top);
          }
        }
      } finally {
        await page.close();
      }
    });
  }
});
