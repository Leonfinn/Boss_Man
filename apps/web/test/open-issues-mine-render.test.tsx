import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// BOS-2542: Scrum Master log → "Open now" has a "With you only" switch (kept in the link as ?mine=1) and "Download CSV".
// Mounts the real page in Chromium with made-up warnings, flips the switch, reads the saved file, and checks the controls
// fit the owner's screens. With BOSSMAN_SCRATCH set it saves screenshots. Skipped where no browser or Vite is installed.

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const issue = (id: string, ref: string, title: string, holder: string, extra: object = {}) => ({
  id, source: "flag", ticketId: `t-${id}`, ticketRef: ref, ticketTitle: title, warning: "Stuck in review for 3 days", rule: null, holder,
  since: "2026-11-23T09:00:00Z", done: [], nextAt: null, nextText: "Checks again", openedAt: "2026-11-23T08:00:00Z", ...extra,
});
const api = {
  ...API,
  "/api/companies/c1/watchdog/issues": [
    issue("a", "BOS-1", "Fix the, merge", "owner", { done: [{ label: "Nudged", reason: "asked the reviewer", at: "2026-11-23T10:00:00Z" }, { label: "Looked", reason: "still waiting", at: "2026-11-23T11:00:00Z" }], nextAt: "2026-11-24T09:00:00Z" }),
    issue("b", "BOS-2", "=Handled by the team", "scrum_master"),
    issue("c", "BOS-3", "CEO has this one", "ceo"),
    issue("e", "BOS-5", "The CEO has this one too, with a very long title that goes on and on so that it has to wrap on a phone screen", "ceo"),
    issue("d", "BOS-4", `=Say "hi" to me`, "owner"),
  ],
};

const PROFILES = [
  { name: "phone-390", width: 390, height: 800, touch: true, ratio: 2 },
  { name: "brave-1667", width: 1667, height: 724, touch: true, ratio: 1 },
  { name: "safari-1550", width: 1550, height: 1000, touch: false, ratio: 1 },
];

describe.skipIf(!can)("Scrum Master log: Open now, With you only and Download CSV (BOS-2542, real page)", () => {
  for (const p of PROFILES) {
    it(`${p.name}: filters, keeps the choice in the link, saves the shown rows, fits the screen`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.ratio, hasTouch: p.touch, isMobile: p.touch });
      try {
        await stubApi(page, api);
        await page.goto(`${server!.resolvedUrls.local[0]}#scrum-master/c1`, { waitUntil: "networkidle" });
        const root = page.locator("#open-now");
        await root.getByText("Fix the, merge").waitFor({ timeout: 15_000 });
        expect(await root.locator("h2").textContent()).toBe("Open now (5)");
        expect(await root.getByText("2 with you").count()).toBe(1);
        expect(await root.locator("li").count()).toBe(5);

        const toggle = root.getByRole("switch", { name: "With you only" });
        const button = root.getByRole("button", { name: "Download CSV" });
        for (const el of [toggle, button]) {
          const box = await el.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(p.width);
        }
        const a = await toggle.boundingBox();
        const b = await button.boundingBox();
        expect(a!.x + a!.width <= b!.x || b!.x + b!.width <= a!.x || a!.y + a!.height <= b!.y || b!.y + b!.height <= a!.y, "switch and button overlap").toBe(true);
        if (p.touch && p.width < 641) expect(b!.height).toBeGreaterThanOrEqual(44);
        if (out) {
          mkdirSync(out, { recursive: true });
          await root.screenshot({ path: path.join(out, `open-issues-all-${p.name}.png`) });
        }

        await toggle.check();
        expect(await root.locator("li").count()).toBe(2);
        expect(await root.locator("h2").textContent()).toBe("Open now (5)");
        expect(page.url()).toContain("#/scrum-master/c1?mine=1".replace("#/", "#"));
        if (out) await root.screenshot({ path: path.join(out, `open-issues-mine-${p.name}.png`) });

        const [dl] = await Promise.all([page.waitForEvent("download"), button.click()]);
        expect(dl.suggestedFilename()).toMatch(/^open-warnings-\d{4}-\d{2}-\d{2}\.csv$/);
        expect(readFileSync(await dl.path(), "utf8").split("\r\n")).toEqual([
          "ticket,title,warning,with,since,done so far,next,next at",
          `BOS-1,"Fix the, merge",Stuck in review for 3 days,you,2026-11-23T09:00:00Z,Nudged at 2026-11-23T10:00:00Z: asked the reviewer; Looked at 2026-11-23T11:00:00Z: still waiting,Checks again,2026-11-24T09:00:00Z`,
          `BOS-4,"'=Say ""hi"" to me",Stuck in review for 3 days,you,2026-11-23T09:00:00Z,,Checks again,`,
          "",
        ]);

        // A link with ?mine=1 opens already filtered.
        await page.goto(`${server!.resolvedUrls.local[0]}#scrum-master/c1?mine=1`, { waitUntil: "networkidle" });
        await page.reload({ waitUntil: "networkidle" });
        await root.getByText("Fix the, merge").waitFor();
        expect(await root.locator("li").count()).toBe(2);
        expect(await root.getByRole("switch", { name: "With you only" }).isChecked()).toBe(true);
        // Turning it off shows all again and takes ?mine=1 out of the link.
        await root.getByRole("switch", { name: "With you only" }).uncheck();
        expect(await root.locator("li").count()).toBe(5);
        expect(page.url()).not.toContain("mine=1");
        // The heading is clear of the controls.
        const h = await root.locator("h2").boundingBox();
        const t = await toggle.boundingBox();
        expect(h!.y + h!.height).toBeLessThanOrEqual(t!.y + 1);
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  it("with nothing open there is no switch and no button", async () => {
    const page = await browser!.newPage({ viewport: { width: 1550, height: 1000 } });
    try {
      await stubApi(page, { ...api, "/api/companies/c1/watchdog/issues": [] });
      await page.goto(`${server!.resolvedUrls.local[0]}#scrum-master/c1`, { waitUntil: "networkidle" });
      await page.locator("#open-now").getByText("Nothing open").waitFor({ timeout: 15_000 });
      expect(await page.locator("#open-now").getByRole("switch").count()).toBe(0);
      expect(await page.locator("#open-now").getByRole("button", { name: "Download CSV" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});
