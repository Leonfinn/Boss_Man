import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// BOS-2520: the real Notifications page in a real browser: "Download CSV" sits in the header, saves a real
// notifications-<date>.csv holding the notices shown, and the header does not overflow at desktop or phone width.
// Made-up fixtures through Vite (real-page.ts); every wait is on an event or element. Skipped where no browser is installed.

const browser = await launch();
const server = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const notice = (id: string, over: Record<string, unknown> = {}) => ({
  id, companyId: "c1", company: "Boss Man Co", agentId: null, requested: "note", level: "note", demotedBy: null,
  title: `Notice ${id}`, body: null, link: "#/decisions", pushedAt: null, pushError: null, readAt: null,
  createdAt: new Date().toISOString(), ...over,
});
const LONG = "A very long notice title that goes on and on without any break so the header has to cope ".repeat(4);
// 60 notices, the first with a long title, so the page is tall and the header is under pressure.
const items = [
  notice("one", { title: LONG, requested: "page", level: "flag", demotedBy: "quiet hours", pushError: "phone unreachable", body: "Two, lines" }),
  notice("two", { level: "ask", requested: "ask", pushedAt: new Date().toISOString() }),
  ...Array.from({ length: 58 }, (_, i) => notice(`n${i}`)),
];
const api = { ...API, "/api/notifications": { items, unread: 60 } };

// The owner's two devices and a phone width.
const SIZES = [
  { name: "1667", width: 1667, height: 724, touch: true },
  { name: "1550", width: 1550, height: 900, touch: false },
  { name: "390", width: 390, height: 844, touch: true },
];

describe.skipIf(!browser || !server)("BOS-2520 Notifications Download CSV in a real browser", () => {
  for (const s of SIZES) {
    it(`${s.name}: the button saves the notices shown and the header fits`, async () => {
      const page = await browser!.newPage({ viewport: { width: s.width, height: s.height }, hasTouch: s.touch, isMobile: s.touch });
      try {
        await stubApi(page, api);
        await page.goto(`${server!.resolvedUrls.local[0]}#/notifications`, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Download CSV", exact: true }).waitFor({ timeout: 15_000 });
        const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        expect(o.sw, JSON.stringify(o)).toBeLessThanOrEqual(o.cw);
        // The button sits beside "Mark all read" and the two do not overlap.
        const box = (name: string) => page.getByRole("button", { name, exact: true }).boundingBox();
        const [a, b] = [await box("Download CSV"), await box("Mark all read")];
        expect(a && b).toBeTruthy();
        const apart = a!.x + a!.width <= b!.x + 0.5 || b!.x + b!.width <= a!.x + 0.5 || a!.y + a!.height <= b!.y + 0.5 || b!.y + b!.height <= a!.y + 0.5;
        expect(apart, JSON.stringify({ a, b })).toBe(true);
        const dir = process.env.BOSSMAN_SCRATCH;
        if (dir) await page.screenshot({ path: `${dir}/notifications-csv-${s.name}.png` });
        const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV", exact: true }).click()]);
        expect(file.suggestedFilename()).toMatch(/^notifications-\d{4}-\d{2}-\d{2}\.csv$/);
        const text = readFileSync(await file.path(), "utf8");
        const lines = text.trim().split("\r\n");
        expect(lines).toHaveLength(61);
        expect(text).toContain("A very long notice title");
        expect(text).toContain("phone unreachable");
        expect(text).toContain("#/decisions");
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
