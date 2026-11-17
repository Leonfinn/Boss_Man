import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// BOS-1744: the real Decisions page in a real browser, at a desktop window and a phone width. Every open card
// names its project (or "Company-wide"), the "Filter by project" chips narrow the list, a card spanning two
// projects shows under both chips, and the choice survives a reload. The page is mounted through Vite with
// `/api` answered from made-up fixtures (real-page.ts). Every wait is on an element, never a fixed sleep.
// Skipped, not failed, where no browser or Vite is installed (the runner and CI have both).

const browser = await launch();
const server = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const dev = { id: "p1", name: "Development" };
const web = { id: "p2", name: "Boss Man Website" };
const card = (id: string, question: string, projects: Array<{ id: string; name: string }>) => ({
  id, companyId: "c1", kind: "choice", question, options: ["Yes", "No"], recommendedOption: "Yes", tier: "owner",
  createdAt: new Date().toISOString(), companyName: "Boss Man Co", agentName: null, blocks: [], about: [], projects,
  score: 10, parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 }, reasons: [], ageReason: "", dueDate: null,
});
const decisions = [
  card("d1", "Pick the build runner", [dev]),
  card("d2", "Pick the launch banner", [web]),
  card("d3", "Share the release notes", [dev, web]),
  card("d4", "Hire a new tester", []),
];
const api = { ...API, "/api/decisions": decisions, "/api/decisions/tally": { open: 4, waiting: 0 } };

const SIZES = [
  { name: "desktop", width: 1280, height: 900, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
];

const open = async (s: (typeof SIZES)[number]) => {
  const page = await browser!.newPage({ viewport: { width: s.width, height: s.height }, hasTouch: s.touch, isMobile: s.touch });
  await stubApi(page, api);
  await page.goto(`${server!.resolvedUrls.local[0]}#/decisions`, { waitUntil: "networkidle" });
  await page.waitForSelector("li.decision h2", { timeout: 15_000 });
  return page;
};
const questions = (page: any): Promise<string[]> => page.$$eval("li.decision h2", (els: Element[]) => els.map((e) => (e.textContent ?? "").trim()).sort());
const chip = (page: any, name: string) => page.getByRole("button", { name, exact: true });

describe.skipIf(!browser || !server)("BOS-1744 Decisions project label and filter in a real browser", () => {
  for (const s of SIZES) {
    it(`${s.name}: labels, chips, filtering and the remembered choice`, async () => {
      const page = await open(s);
      try {
        // (a) each card names its project, or Company-wide.
        const tags: Record<string, string> = await page.$$eval("li.decision", (els: Element[]) =>
          Object.fromEntries(els.map((e) => [(e.querySelector("h2")?.textContent ?? "").trim(), (e.querySelector(".project-tag")?.textContent ?? "").trim()])));
        expect(tags).toEqual({
          "Pick the build runner": "Development",
          "Pick the launch banner": "Boss Man Website",
          "Share the release notes": "Development, Boss Man Website",
          "Hire a new tester": "Company-wide",
        });
        // No sideways scroll from the chip row or the label at this width.
        const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        expect(o.sw, JSON.stringify(o)).toBeLessThanOrEqual(o.cw);

        // (b) a chip narrows the list; (c) the two-project card is under both chips.
        await chip(page, "Development").click();
        await page.waitForFunction(() => document.querySelectorAll("li.decision").length === 2);
        expect(await questions(page)).toEqual(["Pick the build runner", "Share the release notes"]);
        await chip(page, "Boss Man Website").click();
        await page.waitForFunction(() => document.querySelectorAll("li.decision").length === 2);
        expect(await questions(page)).toEqual(["Pick the launch banner", "Share the release notes"]);
        await chip(page, "Company-wide").click();
        await page.waitForFunction(() => document.querySelectorAll("li.decision").length === 1);
        expect(await questions(page)).toEqual(["Hire a new tester"]);

        // (d) the choice is still there after a reload.
        await chip(page, "Boss Man Website").click();
        await page.waitForFunction(() => document.querySelectorAll("li.decision").length === 2);
        await page.reload({ waitUntil: "networkidle" });
        await page.waitForSelector("li.decision h2", { timeout: 15_000 });
        await page.waitForFunction(() => document.querySelectorAll("li.decision").length === 2);
        expect(await questions(page)).toEqual(["Pick the launch banner", "Share the release notes"]);
        expect(await chip(page, "Boss Man Website").getAttribute("aria-pressed")).toBe("true");

        // All projects brings every card back.
        await chip(page, "All projects").click();
        await page.waitForFunction(() => document.querySelectorAll("li.decision").length === 4);
      } finally {
        await page.close();
      }
    }, 90_000);
  }
});
