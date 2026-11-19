import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// Real-browser check for Settings → Projects (BOS-1876): each project is one collapsed row with its
// Kanban button in view; "Edit settings" opens one form. With BOSSMAN_SCRATCH set the screens are saved
// as proof shots (SHOT_TAG names before/after). Skipped, not failed, where no browser or Vite is installed.

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const tag = process.env.SHOT_TAG ?? "after";
const mk = (id: string, name: string, extra: object = {}) => ({ id, companyId: "c1", name, repoUrl: null, defaultBranch: "main", verifyCommand: null, deepVerifyCommand: null, landing: "merge", gitHost: null, gitApiBase: null, starred: false, ticketCostCapMicros: null, monthlyCapMicros: null, archivedAt: null, ...extra });
const projects = [mk("p1", "Development", { repoUrl: "https://example.com/acme/dev.git", starred: true }), mk("p2", "Marketing site", { landing: "pull_request", repoUrl: "https://example.com/acme/site.git" }), mk("p3", "Internal tools")];
const presets = { detected: [], standard: [], none: { id: "none", label: "Nothing", command: null, plain: "No check.", needs: [] }, tools: null, error: null };
const api = { ...API, "/api/companies/c1/projects": projects, ...Object.fromEntries(projects.map((p) => [`/api/projects/${p.id}/check-presets`, presets])) };

const PROFILES = [
  { name: "phone-1667-brave", width: 1667, height: 1668, touch: true, ratio: 3 },
  { name: "phone-380", width: 380, height: 800, touch: true, ratio: 2 },
  { name: "desktop-1550", width: 1550, height: 1611, touch: false, ratio: 1 },
];

describe.skipIf(!can)("Settings → Projects rows (BOS-1876)", () => {
  for (const p of PROFILES) {
    it(`renders at ${p.name}`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.ratio, hasTouch: p.touch, isMobile: p.touch });
      try {
        await stubApi(page, api);
        await page.goto(`${server!.resolvedUrls.local[0]}#projects`, { waitUntil: "networkidle" });
        await page.waitForSelector("text=Marketing site", { timeout: 15_000 }).catch(async (e: Error) => {
          if (out) await page.screenshot({ path: path.join(out, `projects-debug-${p.name}.png`) });
          throw new Error(`${e.message}; body: ${(await page.innerText("body")).slice(0, 300)}`);
        });
        if (out) {
          mkdirSync(out, { recursive: true });
          await page.screenshot({ path: path.join(out, `projects-${tag}-${p.name}.png`), fullPage: true });
        }
        if (tag === "after") {
          const kanban = page.getByRole("button", { name: /Open Internal tools.s Kanban/ });
          expect(await kanban.isVisible()).toBe(true);
          await page.getByRole("button", { name: "Edit settings" }).nth(1).click();
          expect(await page.getByRole("button", { name: "Hide settings" }).count()).toBe(1);
          if (out) await page.screenshot({ path: path.join(out, `projects-after-${p.name}-expanded.png`), fullPage: true });
        }
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
