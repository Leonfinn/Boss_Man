// @vitest-environment node
// BOS-2490: Chat's "Find a teammate" box and "Unread only" switch, rendered in a real browser through Vite with
// made-up threads. Every state is covered: the plain list, a role match, Unread only, and "No one matches" with its
// Clear link; then the same box on a phone, where the list is what opens first (`data-picked="no"`). The open
// conversation is checked to stay put while the list narrows. Screenshots of each state go to BOSSMAN_SCRATCH.
// Skipped, not failed, where no browser or Vite is installed.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi, type Page } from "./real-page";

const browser = await launch();
const server = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const reply = (text: string) => ({ role: "assistant", text, createdAt: "2026-11-24T14:00:00Z" });
// The fixture company is c1. a1 is the open conversation (Radagast), and two others have a new reply.
const threads = [
  { id: "a1", name: "Radagast", role: "ceo", duty: null, state: "idle", last: null },
  { id: "a2", name: "Bungle", role: "worker", duty: null, state: "idle", last: reply("The box is built.") },
  { id: "a3", name: "Yaffle", role: "worker", duty: null, state: "idle", last: reply("Sent it back to you.") },
  { id: "a4", name: "Kit", role: "worker", duty: null, state: "idle", last: null },
  { id: "a5", name: "Zippy", role: "manager", duty: null, state: "idle", last: null },
];
const api = {
  ...API,
  "/api/companies/c1/chat/threads": threads,
  "/api/companies/c1/chat": { agentId: "a1", state: "idle", items: [{ id: "m1", role: "assistant", text: "Morning. What do you need?", createdAt: "2026-11-24T09:00:00Z" }] },
};

const open = async (width: number, height: number, touch: boolean, hash: string) => {
  const page = await browser!.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  await stubApi(page, api);
  await page.goto(`${server!.resolvedUrls.local[0]}${hash}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".messenger-list ul li a", { timeout: 15_000 }).catch(async (e: Error) => {
    const text = await page.evaluate(() => document.body.innerText);
    throw new Error(`${e.message}\nPage text: ${text.slice(0, 600)}`);
  });
  return page;
};
const names = (page: Page): Promise<string[]> =>
  page.$$eval(".messenger-list ul li a .name", (els: Element[]) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()));
const shots = process.env.BOSSMAN_SCRATCH;
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  try {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
  } catch {
    /* a screenshot is not the test */
  }
};

describe.skipIf(!browser || !server)("BOS-2490 Chat team list filter in a real browser", () => {
  it("desktop: filters by name or role, Unread only, No one matches with Clear, and the open conversation stays", async () => {
    const page = await open(1280, 900, false, "#/chat/c1/a1");
    try {
      expect(await names(page)).toEqual(["Radagast CEO", "Bungle Worker", "Yaffle Worker", "Kit Worker", "Zippy Manager"]);
      await shot(page, "bos-2490-desktop-1-default");

      const box = page.getByRole("searchbox", { name: "Find a teammate" });
      await box.fill("man");
      await page.waitForFunction(() => document.querySelectorAll(".messenger-list ul li a").length === 1);
      expect(await names(page)).toEqual(["Zippy Manager"]);
      expect(await page.textContent(".messenger-head h2")).toBe("Radagast");
      await shot(page, "bos-2490-desktop-2-role-match");

      await box.fill("");
      await page.getByRole("switch", { name: "Unread only" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".messenger-list ul li a").length === 2);
      expect(await names(page)).toEqual(["Bungle Worker", "Yaffle Worker"]);
      await shot(page, "bos-2490-desktop-3-unread-only");

      await box.fill("zzz");
      await page.waitForSelector(".team-none", { timeout: 15_000 });
      expect(await page.textContent(".team-none")).toContain("No one matches");
      expect(await page.textContent(".messenger-head h2")).toBe("Radagast");
      await shot(page, "bos-2490-desktop-4-no-match");

      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".messenger-list ul li a").length === 5);
      expect(await box.inputValue()).toBe("");
      expect(await page.isChecked('input[role="switch"]')).toBe(false);
      const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(overflow.sw, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.cw);
    } finally {
      await page.close();
    }
  });

  it("phone: the box sits above the list, which is what opens first", async () => {
    const page = await open(390, 844, true, "#/chat/c1");
    try {
      expect(await page.getAttribute(".messenger", "data-picked")).toBe("no");
      const above = await page.evaluate(() => {
        const find = document.querySelector(".team-find")!.getBoundingClientRect();
        const list = document.querySelector(".messenger-list ul")!.getBoundingClientRect();
        return find.bottom <= list.top;
      });
      expect(above).toBe(true);
      const box = page.getByRole("searchbox", { name: "Find a teammate" });
      await box.fill("quiet");
      await page.waitForSelector(".team-none", { timeout: 15_000 });
      expect(await page.textContent(".team-none")).toContain("No one matches");
      await shot(page, "bos-2490-phone-1-no-match");
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".messenger-list ul li a").length === 5);
      await page.getByRole("switch", { name: "Unread only" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".messenger-list ul li a").length === 2);
      expect(await names(page)).toEqual(["Bungle Worker", "Yaffle Worker"]);
      await shot(page, "bos-2490-phone-2-unread-only");
      const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(overflow.sw, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.cw);
    } finally {
      await page.close();
    }
  });
});
