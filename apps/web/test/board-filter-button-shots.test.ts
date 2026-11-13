import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launch, openApp, startVite } from "./real-page";

// Real-browser proof shots and behaviour checks for the Board's Filter button (BOS-1194, design
// design/board-filter-button-bos-1190). The bar must show only Add task, search and Filter; on a
// phone the first column has to start on the first screen. With BOSSMAN_SCRATCH set, the same board
// is saved at the ticket's three sizes (390 px phone, Safari 1550×1611 mouse, Brave 1667×724 touch),
// closed panel and open panel. Skipped, not failed, where no browser or Vite is installed.

const foldable = JSON.parse(readFileSync(new URL("./device-profiles/owner-brave-foldable.json", import.meta.url), "utf8")) as {
  readings: Array<{ width: number; units: { vh: number }; coarsePointer: boolean }>;
};
const fp = foldable.readings[0]!;

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const saveShot = async (name: string, page: any) => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name), fullPage: false });
};

// The ticket's three sizes, plus the saved-filter-on-arrival state at each.
const SIZES = [
  { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "safari-1550", width: 1550, height: 1611, touch: false },
  { name: "brave-1667", width: fp.width, height: fp.units.vh, touch: fp.coarsePointer },
] as const;

const open = (size: (typeof SIZES)[number], init?: (page: any) => Promise<void>) =>
  (async () => {
    const page = await openApp(browser!, server!, { width: size.width, height: size.height, hasTouch: size.touch, hash: "#board/p1" });
    if (init) await init(page);
    await page.waitForSelector(".board-bar", { timeout: 15_000 });
    await page.waitForTimeout(300);
    return page;
  })();

describe.skipIf(!can)("Board Filter button (BOS-1194)", () => {
  it("shows only Add task, search and Filter above the columns", async () => {
    const page = await open(SIZES[1]);
    try {
      const bar = page.locator(".board-bar");
      // No old controls: no segmented Show group, no Assigned to / Feature labels, no Working now chip.
      expect(await bar.getByText("Assigned to").count()).toBe(0);
      expect(await bar.getByText("Working now", { exact: true }).count()).toBe(0);
      const filter = bar.getByRole("button", { name: /^Filter/ });
      expect(await filter.count()).toBe(1);
      expect(await bar.locator("input[type='search']").count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it("starts the first column on the first screen on a 390 px phone", async () => {
    const page = await open(SIZES[0]);
    try {
      const firstColumn = await page.locator(".board-scroll .lane").first().boundingBox();
      expect(firstColumn, "a column is present").not.toBeNull();
      // The old bar pushed the first column to 744 px down, below an 844 px screen; the new bar keeps
      // the column top comfortably above the fold.
      expect(firstColumn!.y, "first column starts above the fold").toBeLessThan(844);
    } finally {
      await page.close();
    }
  });

  it("opens a non-modal popover that counts on, and returns focus on Escape", async () => {
    const page = await open(SIZES[1], async (p) => {});
    try {
      const filter = page.getByRole("button", { name: /^Filter/ });
      await filter.click();
      const dialog = page.getByRole("dialog", { name: "Filter tasks" });
      expect(await dialog.count()).toBe(1);
      expect(await dialog.getAttribute("aria-modal")).toBeNull();
      await dialog.getByRole("switch").click();
      // The button now carries a count and the board shows a chip.
      expect(await page.locator(".filter-count").innerText()).toBe("1");
      expect(await page.locator(".filter-chip").count()).toBe(1);
      await page.keyboard.press("Escape");
      expect(await page.getByRole("dialog", { name: "Filter tasks" }).count()).toBe(0);
      expect(await filter.evaluate((el: Element) => el === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("opens a modal bottom sheet with Show N tasks on a phone", async () => {
    const page = await open(SIZES[0], async (p) => {});
    try {
      await page.getByRole("button", { name: /^Filter/ }).click();
      const dialog = page.getByRole("dialog", { name: "Filter tasks" });
      expect(await dialog.getAttribute("aria-modal")).toBe("true");
      expect(await page.getByRole("button", { name: /Show \d+ tasks?/ }).count()).toBe(1);
      // No chips on a phone.
      expect(await page.locator(".filter-chip").count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  for (const size of SIZES) {
    it.skipIf(!out)(`saves the board closed and open at ${size.name}`, async () => {
      const page = await open(size);
      await saveShot(`bos1194-${size.name}-board.png`, page);
      await page.getByRole("button", { name: /^Filter/ }).click();
      await page.waitForTimeout(300);
      await saveShot(`bos1194-${size.name}-filter.png`, page);
      await page.close();
    }, 60_000);

    it.skipIf(!out)(`saves a filter turned on at ${size.name}`, async () => {
      const page = await open(size);
      await page.getByRole("button", { name: /^Filter/ }).click();
      // Turn Working now on: the button counts it, wide screens show a chip, and columns leave only working cards.
      await page.getByRole("switch").click();
      await page.waitForTimeout(300);
      // Close the panel (wide: Escape; phone: Show N tasks) so the bar and columns show with the filter on.
      if (size.width <= 640) await page.getByRole("button", { name: /Show \d+ tasks?/ }).click();
      else await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      // The filter is visible on arrival: the button counts it, and wide screens show it as a chip.
      expect(await page.locator(".filter-count").innerText()).toBe("1");
      expect(await page.locator(".filter-chip").count()).toBe(size.width <= 640 ? 0 : 1);
      await saveShot(`bos1194-${size.name}-filtered.png`, page);
      await page.close();
    }, 60_000);
  }

  it("lines up the four group labels on the left, at all sizes", async () => {
    for (const size of [SIZES[1], SIZES[0]]) {
      const page = await open(size);
      try {
        await page.getByRole("button", { name: /^Filter/ }).click();
        const xs: number[] = [];
        for (const name of ["Show", "Assigned to", "Feature", "Working now"]) {
          const box = await page.locator(".filter-label", { hasText: name }).first().boundingBox();
          xs.push(box!.x);
        }
        // Every label starts within a pixel of the first: none is centred.
        for (const x of xs) expect(Math.abs(x - xs[0]!), `${size.name}: labels flush left`).toBeLessThanOrEqual(1);
      } finally {
        await page.close();
      }
    }
  });

  it("fits the popover on screen at the Brave 1667×724 fold", async () => {
    const page = await open(SIZES[2]);
    try {
      await page.getByRole("button", { name: /^Filter/ }).click();
      const panel = await page.locator("#filter-panel").boundingBox();
      expect(panel, "the panel is on screen").not.toBeNull();
      expect(panel!.y + panel!.height, "the popover's bottom is inside the 724 px viewport").toBeLessThanOrEqual(724);
    } finally {
      await page.close();
    }
  });
});
