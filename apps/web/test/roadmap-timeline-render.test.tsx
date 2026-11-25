// @vitest-environment node
// BOS-2560 (design BOS-2558, rule BOS-2511): the Roadmap's Timeline tab in a real browser with owner-shaped data (10 open
// milestones with long titles, a 200-character title with no spaces, two due 4 days apart and two on the same day, one
// with no date, four done from October on), at the owner's three widths: 724 (the phone app), 1667 (Brave) and 380.
// It fails if any title, chip or meta line overlaps another or a marker, if anything is clipped or the page scrolls
// sideways, if a done milestone shows before its group is opened, if a row's status word disagrees with the summary line,
// or if a row is under 44 px tall. It also opens a row and checks the chart's labels. Selectors list the old markup too
// (`.rm-ms b`, `.rm-dot`), so the same test fails on the code from before BOS-2560 (titles printed over each other).
// The ./real-page helper starts the real app under Vite, so apps/web/src/styles.css is loaded as shipped, and drives it in
// playwright/chromium; every check below measures geometry with getBoundingClientRect.
// Skipped, not failed, where no browser is installed.
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const NOSPACE = "Supercalifragilistic".repeat(10); // 200 characters, nothing to wrap at

type Spec = { title: string; status: string; due: number | null; total: number; done: number; blocked?: number; left: number; late?: number; finish: number | null };
const open: Spec[] = [
  { title: "Fix the onboarding drop-off before the newsletter goes out", status: "late", due: -6, total: 4, done: 2, blocked: 1, left: 8, finish: 11 },
  { title: "Public beta: sign-in, billing and onboarding polished for first customers", status: "on_track", due: 10, total: 12, done: 11, left: 5, finish: 3 },
  { title: "Portal launch", status: "at_risk", due: 14, total: 2, done: 1, blocked: 1, left: 20, finish: 14 },
  { title: "Move every agent's check run onto the shared check queue with the new per-ticket memory limits", status: "at_risk", due: 26, total: 8, done: 2, left: 30, late: 23, finish: 49 },
  { title: NOSPACE, status: "on_track", due: 26, total: 3, done: 1, left: 6, finish: 20 },
  { title: "General availability", status: "on_track", due: 52, total: 5, done: 0, left: 21, finish: 21 },
  { title: "Second region", status: "no_work", due: 69, total: 0, done: 0, left: 0, finish: null },
  { title: "Ideas to look at when there is time", status: "no_date", due: null, total: 3, done: 0, left: 8, finish: null },
  { title: "Customer export to a spreadsheet, with every column the finance team asked for in the autumn", status: "on_track", due: 40, total: 6, done: 2, left: 9, finish: 30 },
  { title: "Help centre", status: "at_risk", due: 20, total: 5, done: 1, left: 13, late: 4, finish: 24 },
];
const doneOnes = [-35, -20, -12, -4].map((f, i): Spec => ({ title: `Finished milestone number ${i + 1}, shipped in the autumn`, status: "done", due: f + 2, total: 3, done: 3, left: 0, finish: 0 }));

const weeks = (i: number) => Array.from({ length: 8 }, (_, w) => ({ weekEnd: day(-7 * (7 - w)), done: w * 2 + i, total: 20 + w + i }));
const milestone = (s: Spec, i: number) => ({
  id: `m${i}`, title: s.title, targetDate: s.due == null ? null : day(s.due), total: s.total, done: s.done, blocked: s.blocked ?? 0, active: 1, status: s.status, horizon: "now", pinned: null,
  finishedAt: s.status === "done" ? `${day(s.due! - 2)}T10:00:00Z` : null,
  forecast: { pointsDone: s.done * 5, pointsLeft: s.left, unsized: 0, pace: s.finish == null ? 0 : 4, expectedFinish: s.finish == null ? null : day(s.finish), daysLate: s.late ?? 0 },
  burnup: weeks(i),
});
const api: Record<string, unknown> = {
  ...API,
  "/api/roadmap": [{ id: "c1", name: "Fernleaf Studio", objectives: [{ id: "o1", title: "Launch the customer portal", priority: 1, status: "active", keyResults: [], milestones: [...doneOnes, ...open].map(milestone) }] }],
  "/api/roadmap/features": [],
};

const browser = await launch();
const vite = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

type Box = { name: string; text: string; x: number; y: number; w: number; h: number; group: string | null };

/** Everything the page measures, run inside the browser. */
const measure = () => {
  const box = (el: Element, name: string): Box => {
    const r = el.getBoundingClientRect();
    const strip = el.closest(".rm-strip");
    return { name, text: (el.textContent ?? "").slice(0, 40), x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height, group: strip ? String([...document.querySelectorAll(".rm-strip")].indexOf(strip)) : null };
  };
  // checkVisibility() is false inside a closed <details>, where the box can still be measured.
  const visible = (el: Element) => el.checkVisibility() && el.getBoundingClientRect().width > 0;
  const pick = (sel: string, name: string) => [...document.querySelectorAll(sel)].filter(visible).map((el) => box(el, name));
  const titles = [...document.querySelectorAll(".rm-title, .rm-ms b")].filter(visible);
  const card = document.querySelector(".rm-obj")!.getBoundingClientRect();
  return {
    boxes: [
      ...pick(".rm-summary", "summary"),
      ...pick(".rm-axis .month", "month"),
      ...pick(".rm-chip", "chip"),
      ...pick(".rm-title, .rm-ms b", "title"),
      ...pick(".rm-meta, .rm-meta2, .rm-ms small", "meta"),
      ...pick(".rm-strip .due, .rm-strip .finish, .rm-dot", "marker"),
      ...pick(".rm-chart text", "chart label"),
    ],
    clipped: titles.filter((t) => t.scrollWidth > t.clientWidth + 1 || t.getBoundingClientRect().right > card.right + 0.5 || t.getBoundingClientRect().left < card.left - 0.5).map((t) => (t.textContent ?? "").slice(0, 40)),
    sideways: document.documentElement.scrollWidth > innerWidth,
    rowCount: document.querySelectorAll(".rm-row").length,
    doneShown: [...document.querySelectorAll(".rm-done li")].some(visible),
    shortRows: [...document.querySelectorAll(".rm-rowbtn")].filter((b) => b.getBoundingClientRect().height < 44).length,
    chips: [...document.querySelectorAll(".rm-rows .rm-chip")].map((c) => (c.textContent ?? "").replace(/^\S+\s/, "").trim()),
    summary: document.querySelector(".rm-summary")?.textContent ?? "",
    chartInCard: [...document.querySelectorAll(".rm-chart")].every((c) => c.getBoundingClientRect().right <= card.right + 0.5),
  };
};

const overlaps = (boxes: Box[]) => {
  const bad: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.group !== null && a.group === b.group) continue; // a due date and a finish on the same day may sit together in one strip
      if (a.x + a.w - 1 > b.x && b.x + b.w - 1 > a.x && a.y + a.h - 1 > b.y && b.y + b.h - 1 > a.y) bad.push(`${a.name} "${a.text}" over ${b.name} "${b.text}"`);
    }
  return bad;
};

describe.skipIf(!browser || !vite)("Roadmap timeline rows (BOS-2560)", () => {
  for (const width of [724, 1667, 380]) {
    it(`${width} px: no title, chip, line or marker overlaps another, nothing is clipped, one status per milestone`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: width === 724 ? 724 : 900 } });
      try {
        await stubApi(page, api);
        await page.goto(`${vite!.resolvedUrls.local[0]}#roadmap/timeline`, { waitUntil: "networkidle" });
        await page.waitForSelector(".rm-obj", { timeout: 15_000 });
        const closed = await page.evaluate(measure);
        expect(closed.rowCount, "ten open rows").toBe(10);
        expect(overlaps(closed.boxes)).toEqual([]);
        expect(closed.clipped).toEqual([]);
        expect(closed.sideways, "no sideways scroll").toBe(false);
        expect(closed.doneShown, "done milestones are folded").toBe(false);
        expect(closed.shortRows, "rows under 44 px tall").toBe(0);
        // One status: the chips on the rows add up to the words in the summary line.
        const tally = (w: string) => closed.chips.filter((c: string) => c === w).length;
        for (const [word, label] of [["Late", "late"], ["At risk", "at risk"], ["On track", "on track"], ["No date", "no date"], ["No tickets", "with no tickets"]] as const)
          expect(closed.summary, word).toContain(`${tally(word)} ${label}`);

        // Open the longest-titled rows: the chart's labels must not touch each other either.
        for (const index of [4, 5]) {
          await page.locator(".rm-rowbtn").nth(index).click();
          await page.waitForSelector(".rm-chart");
          const opened = await page.evaluate(measure);
          expect(overlaps(opened.boxes)).toEqual([]);
          expect(opened.clipped).toEqual([]);
          expect(opened.sideways).toBe(false);
          expect(opened.chartInCard).toBe(true);
        }

        // The Done group opens to show its four, newest first.
        await page.locator(".rm-done > summary").click();
        const doneTitles: string[] = await page.evaluate(() => [...document.querySelectorAll(".rm-done .rm-title")].map((t) => t.textContent ?? ""));
        expect(doneTitles).toHaveLength(4);
        expect(doneTitles[0]).toContain("number 4");
      } finally {
        await page.close();
      }
    }, 90_000);
  }
});
