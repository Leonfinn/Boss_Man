import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launch, openApp, startVite } from "./real-page";

// Real-browser checks for the new main menu (BOS-1506, design simpler-menu-and-settings-bos-1491):
// about ten rows, Settings and Log out pinned in view with nothing to scroll on a 724 px window,
// a group opening as a side panel there and unfolding in place on a tall window or a phone.
// With BOSSMAN_SCRATCH set the same screens are saved as proof shots. Skipped, not failed, where
// no browser or Vite is installed.

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const shot = async (name: string, page: any) => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name), fullPage: false });
};
const SHORT = { width: 1667, height: 724, touch: true };
const TALL = { width: 1550, height: 1611, touch: false };
const PHONE = { width: 390, height: 844, touch: true };
const open = (s: { width: number; height: number; touch: boolean }) => openApp(browser!, server!, { width: s.width, height: s.height, hasTouch: s.touch, sideCollapsed: false, hash: "#board/p1" });

describe.skipIf(!can)("Main menu (BOS-1506)", () => {
  it("on a 724 px window keeps Settings and Log out in view, nothing to scroll, and opens a group as a panel", async () => {
    const page = await open(SHORT);
    try {
      const nav = page.locator("nav.side");
      const settings = nav.getByRole("link", { name: "Settings" });
      const box = await settings.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(SHORT.height);
      expect(await nav.getByRole("button", { name: "Log out" }).isVisible()).toBe(true);
      // Ten top-level rows above the pinned Settings, and the list itself does not scroll.
      expect(await nav.locator(".nav-scroll > section > ul > li").count()).toBe(10);
      await shot("menu-brave-1667x724-closed.png", page);
      const sizes = await page.evaluate(() => { const s = document.querySelector(".nav-scroll")!; const n = document.querySelector("nav.side")!; return { scroll: s.scrollHeight, client: s.clientHeight, nav: n.clientHeight, navScroll: n.scrollHeight, row: document.querySelector(".nav-scroll a.nav")!.getBoundingClientRect().height }; });
      expect(sizes.scroll, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.client + 1);
      await nav.getByRole("button", { name: /^Product/ }).click();
      expect(await page.getByRole("group", { name: "Product" }).getByRole("link", { name: "Feedback" }).isVisible()).toBe(true);
      await shot("menu-brave-1667x724-panel.png", page);
    } finally {
      await page.close();
    }
  });

  it("on a tall window unfolds the groups in place and keeps every page one click away", async () => {
    const page = await open(TALL);
    try {
      const nav = page.locator("nav.side");
      for (const name of ["Roadmap", "Features", "Feedback", "Plan", "Agents", "Skills", "Engagements", "Runs", "Scrum Master log", "Workflow report", "Settings"]) {
        expect(await nav.getByRole("link", { name }).isVisible(), name).toBe(true);
      }
      await shot("menu-safari-1550x1611-open.png", page);
    } finally {
      await page.close();
    }
  });

  it("on a phone opens the Menu sheet with 44 px rows and a group unfolding in place", async () => {
    const page = await open(PHONE);
    try {
      await page.locator("nav.side .menu-toggle").click();
      const product = page.locator("nav.side").getByRole("button", { name: /^Product/ });
      expect((await product.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await product.click();
      const link = page.locator("nav.side").getByRole("link", { name: "Roadmap" });
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await shot("menu-phone-390-open.png", page);
    } finally {
      await page.close();
    }
  });
});
