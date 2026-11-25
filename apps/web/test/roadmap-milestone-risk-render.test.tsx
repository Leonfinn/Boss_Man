// @vitest-environment node
// BOS-2581 (rule BOS-2511): the "CEO manages at risk" switch and its warning under a milestone's row, at the owner's three
// widths (724 the phone app, 1667 Brave, 380 a small phone). It fails if the switch or its text is inside the row's button
// (a button in a button can't work), if it doesn't line up with the reason line on a wide screen, if it runs out of the
// card, if the page scrolls sideways, or if any control is under 34 px tall. The ./real-page helper starts the real app
// under Vite, so apps/web/src/styles.css is loaded as shipped, and drives it in playwright/chromium; every check measures
// geometry with getBoundingClientRect. With BOSSMAN_SCRATCH set it saves before and after screenshots per width (before:
// off, with its button; after: the cost warning shown, and the on state). Skipped, not failed, where no browser is installed.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
type Spec = { title: string; on: boolean; status: string; due: number; reason: string | null };
const open: Spec[] = [
  { title: "Launch the customer portal", on: false, status: "at_risk", due: 9, reason: "At risk: at its pace the unbuilt work finishes about Sat 5 Dec, 15 days after its date." },
  { title: "Public beta for the first customers, with sign-in and billing", on: true, status: "late", due: -4, reason: "Late: its date passed 4 days ago and 2 tickets are not built and live yet." },
];
const weeks = (i: number) => Array.from({ length: 8 }, (_, w) => ({ weekEnd: day(-7 * (7 - w)), done: w * 2 + i, total: 20 + w + i }));
const milestone = (s: Spec, i: number) => ({
  id: `m${i}`, title: s.title, targetDate: day(s.due), total: 5, done: 2, blocked: 0, active: 1, status: s.status, horizon: "now", pinned: null, finishedAt: null,
  reason: s.reason, reasonTickets: [], forecast: { pointsDone: 10, pointsLeft: 6, unsized: 0, pace: 4, expectedFinish: day(s.due - 1), daysLate: 0 }, burnup: weeks(i), ceoManagesRisk: s.on,
});
const api: Record<string, unknown> = {
  ...API,
  "/api/roadmap": [{ id: "c1", name: "Fernleaf Studio", objectives: [{ id: "o1", title: "Launch the customer portal", priority: 1, status: "active", keyResults: [], milestones: open.map(milestone) }] }],
  "/api/roadmap/features": [],
};

const out = process.env.BOSSMAN_SCRATCH;
const shots = out ? path.join(out, "shots") : null;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await launch();
const vite = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

const measure = () => {
  const rect = (el: Element) => el.getBoundingClientRect();
  const card = rect(document.querySelector(".rm-obj")!);
  return {
    sideways: document.documentElement.scrollWidth > innerWidth,
    rows: [...document.querySelectorAll(".rm-row")].map((li) => {
      const sw = li.querySelector(".rm-risk")!;
      const reason = li.querySelector(".rm-reason");
      const title = li.querySelector(".rm-title")!;
      const btn = li.querySelector(".rm-rowbtn")!;
      const controls = [...sw.querySelectorAll("button")].map((b) => rect(b).height);
      return {
        on: sw.getAttribute("data-on"),
        inButton: !!sw.closest("button"),
        buttonsInButton: li.querySelectorAll("button button").length,
        left: rect(sw).left,
        right: rect(sw).right,
        top: rect(sw).top,
        reasonBottom: reason ? rect(reason).bottom : null,
        btnBottom: rect(btn).bottom,
        titleLeft: rect(title).left,
        minControl: controls.length ? Math.min(...controls) : 999,
        text: sw.textContent,
      };
    }),
    allLeft: rect(document.querySelector(".rm-risk-all")!).left,
    cardRight: card.right,
  };
};

describe.skipIf(!browser || !vite)("CEO manages at risk switch (BOS-2581)", () => {
  for (const width of [724, 1667, 380]) {
    it(`${width} px: the switch sits under its reason line outside the button, inside the card, with no sideways scroll`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: width === 724 ? 724 : 900 } });
      try {
        await stubApi(page, api);
        await page.goto(`${vite!.resolvedUrls.local[0]}#roadmap/timeline`, { waitUntil: "networkidle" });
        await page.waitForSelector(".rm-risk", { timeout: 15_000 });
        const before = (await page.evaluate(measure)) as ReturnType<typeof measure>;
        if (shots) await page.screenshot({ path: path.join(shots, `milestone-risk-${width}-before.png`), fullPage: true });
        expect(before.sideways, "no sideways scroll").toBe(false);
        expect(before.rows.map((r) => r.on).sort()).toEqual(["off", "on"]);
        for (const r of before.rows) {
          expect(r.inButton, `${r.on}: switch outside the row's button`).toBe(false);
          expect(r.buttonsInButton, `${r.on}: no button inside a button`).toBe(0);
          expect(r.top, `${r.on}: below its reason line`).toBeGreaterThanOrEqual((r.reasonBottom ?? r.btnBottom) - 1);
          expect(r.right, `${r.on}: inside the card`).toBeLessThanOrEqual(before.cardRight + 0.5);
          expect(r.minControl, `${r.on}: controls are tappable`).toBeGreaterThanOrEqual(34);
          // Wide: lined up with the title (and so with the reason line). On a phone it is flush with the row's text.
          if (width > 600) expect(Math.abs(r.left - r.titleLeft), `${r.on}: aligned with the title`).toBeLessThan(2);
        }
        expect(before.rows.find((r) => r.on === "off")!.text).toContain("CEO manages At risk");
        expect(before.rows.find((r) => r.on === "on")!.text).toContain("costs a CEO run");
        // The "for all" control lines up with the card's milestones, not the page.
        expect(before.allLeft).toBeGreaterThanOrEqual(0);
        expect(before.allLeft).toBeLessThanOrEqual(before.rows[0]!.left + 0.5);

        // Pressing the off switch shows the cost warning, still inside the card at this width.
        await page.click(".rm-row .rm-risk[data-on='off'] button");
        const after = (await page.evaluate(measure)) as ReturnType<typeof measure>;
        if (shots) await page.screenshot({ path: path.join(shots, `milestone-risk-${width}-warning.png`), fullPage: true });
        expect(after.sideways, "no sideways scroll with the warning").toBe(false);
        const off = after.rows.find((r) => r.on === "off")!;
        expect(off.text).toContain("costs a CEO run");
        expect(off.right).toBeLessThanOrEqual(after.cardRight + 0.5);
        for (const r of after.rows) expect(r.minControl, `${r.on}: controls stay tappable`).toBeGreaterThanOrEqual(34);
      } finally {
        await page.close();
      }
    }, 90_000);
  }
});
