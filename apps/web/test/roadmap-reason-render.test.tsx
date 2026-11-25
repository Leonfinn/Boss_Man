// @vitest-environment node
// BOS-2579 (design BOS-2573, Sooty's notes): the reason line under a milestone's row, in a real browser at the owner's three
// widths (724, 1667, 380). It fails if the line sits inside the row's button (a link in a button can't be reached by
// keyboard), if it isn't lined up with the title on a wide screen, if the "Live, being checked" chip wraps, if any line
// overlaps another or runs out of the card, or if the page scrolls sideways. The ./real-page helper starts the real app under
// Vite, so apps/web/src/styles.css is loaded as shipped, and drives it in playwright/chromium; every check measures geometry with getBoundingClientRect.
// Skipped, not failed, where no browser is installed.
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

type Spec = { title: string; status: string; due: number; reason: string | null; tickets?: Array<{ ref: string; id: string }> };
const open: Spec[] = [
  { title: "Approved work lands on its own", status: "live_checked", due: 9, reason: "All built and live. 5 final checks running; 2 have gone quiet: BOS-1703, BOS-1964; last check ends Sat 5 Dec.", tickets: [{ ref: "BOS-1703", id: "t1" }, { ref: "BOS-1964", id: "t2" }] },
  { title: "Example milestone that is really at risk", status: "at_risk", due: 9, reason: "At risk: BOS-2541 waits on your card.", tickets: [{ ref: "BOS-2541", id: "t3" }] },
  { title: "Late example with a long title so the title itself wraps onto a second line on a phone", status: "late", due: -3, reason: "Late: its date passed 3 days ago and 2 tickets are not built and live yet." },
  { title: "On track needs no line", status: "on_track", due: 30, reason: null },
];

const weeks = (i: number) => Array.from({ length: 8 }, (_, w) => ({ weekEnd: day(-7 * (7 - w)), done: w * 2 + i, total: 20 + w + i }));
const milestone = (s: Spec, i: number) => ({
  id: `m${i}`, title: s.title, targetDate: day(s.due), total: 5, done: 2, blocked: 0, active: 1, status: s.status, horizon: "now", pinned: null, finishedAt: null,
  reason: s.reason, reasonTickets: s.tickets ?? [],
  forecast: { pointsDone: 10, pointsLeft: 6, unsized: 0, pace: 4, expectedFinish: day(s.due - 1), daysLate: 0 },
  burnup: weeks(i),
});
const api: Record<string, unknown> = {
  ...API,
  "/api/roadmap": [{ id: "c1", name: "Fernleaf Studio", objectives: [{ id: "o1", title: "Launch the customer portal", priority: 1, status: "active", keyResults: [], milestones: open.map(milestone) }] }],
  "/api/roadmap/features": [],
};

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
      const reason = li.querySelector(".rm-reason");
      const title = li.querySelector(".rm-title")!;
      const btn = li.querySelector(".rm-rowbtn")!;
      const chip = li.querySelector(".rm-chip")!;
      return {
        status: li.getAttribute("data-status"),
        hasReason: !!reason,
        reasonInButton: !!reason && !!reason.closest("button"),
        linksInButton: li.querySelectorAll("button a").length,
        reasonLeft: reason ? rect(reason).left : null,
        titleLeft: rect(title).left,
        reasonTop: reason ? rect(reason).top : null,
        btnBottom: rect(btn).bottom,
        reasonRight: reason ? rect(reason).right : null,
        reasonLines: reason ? Math.round(rect(reason).height / parseFloat(getComputedStyle(reason).lineHeight || "18")) : 0,
        chipHeight: rect(chip).height,
        chipText: chip.textContent,
        links: [...li.querySelectorAll(".rm-reason a")].map((a) => a.getAttribute("href")),
      };
    }),
    cardRight: card.right,
  };
};

describe.skipIf(!browser || !vite)("Roadmap reason line (BOS-2579)", () => {
  for (const width of [724, 1667, 380]) {
    it(`${width} px: the reason sits under its row outside the button, lined up with the title, inside the card`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: width === 724 ? 724 : 900 } });
      try {
        await stubApi(page, api);
        await page.goto(`${vite!.resolvedUrls.local[0]}#roadmap/timeline`, { waitUntil: "networkidle" });
        await page.waitForSelector(".rm-obj", { timeout: 15_000 });
        const m = await page.evaluate(measure);
        expect(m.sideways, "no sideways scroll").toBe(false);
        expect(m.rows.map((r) => [r.status, r.hasReason]).sort()).toEqual([["at_risk", true], ["late", true], ["live_checked", true], ["on_track", false]]);
        for (const r of m.rows.filter((x) => x.hasReason)) {
          expect(r.reasonInButton, `${r.status}: reason outside the button`).toBe(false);
          expect(r.linksInButton).toBe(0);
          expect(r.reasonTop!, "under the row").toBeGreaterThanOrEqual(r.btnBottom - 1);
          expect(r.reasonRight!, "inside the card").toBeLessThanOrEqual(m.cardRight + 0.5);
          // Wide: lined up with the title. On a phone the chip sits above, so the line is flush with the row's text.
          if (width > 600) expect(Math.abs(r.reasonLeft! - r.titleLeft), `${r.status}: aligned with the title`).toBeLessThan(2);
        }
        const live = m.rows.find((r) => r.status === "live_checked")!;
        expect(live.chipText).toContain("Live, being checked");
        expect(live.chipHeight, "the chip stays on one line").toBeLessThan(26);
        expect(live.links).toEqual(["#/tickets/t1", "#/tickets/t2"]);
        expect(m.rows.find((r) => r.status === "at_risk")!.links).toEqual(["#/tickets/t3"]);
      } finally {
        await page.close();
      }
    }, 90_000);
  }
});
