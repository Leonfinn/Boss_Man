import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// BOS-2815: the real connect step in Chromium, at the owner's desktop width and at a phone's, in the states the
// ticket names: nothing chosen, a plan's install-first steps, a key's browser-only steps, the wrong-key error,
// connected, and step 7 before anything is saved. Every row must be the same size (nothing favoured) and fit the
// screen. With BOSSMAN_SCRATCH set it saves screenshots there. Skipped where no browser or Vite is installed.

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const out = process.env.BOSSMAN_SCRATCH;

const company = { id: "c1", name: "App Co", mission: "Reports for clients", paused: false, agents: [{ id: "a1", name: "CEO", role: "ceo", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null }] };
const checklist = ["company", "project", "runner", "credential", "git", "checks", "funding", "ticket"].map((id) => ({ id, label: id, done: false }));

const base = (step: number, extra: Record<string, unknown> = {}) => ({
  ...API,
  "/api/companies": [company],
  "/api/setup-progress": { dismissed: false, step, companyId: "c1" },
  "/api/companies/c1/setup-checklist": checklist,
  "/api/companies/c1/grants": [],
  "/api/funding-sources": [],
  ...extra,
});

const PROFILES = [
  { name: "desktop-1440", width: 1440, height: 900, touch: false, ratio: 1 },
  { name: "phone-390", width: 390, height: 844, touch: true, ratio: 2 },
];

describe.skipIf(!can)("setup connect step, real page (BOS-2815)", () => {
  for (const p of PROFILES) {
    it(`${p.name}: every option is one row of the same size, its steps open one at a time, and the error says what to copy`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.ratio, hasTouch: p.touch, isMobile: p.touch });
      try {
        await stubApi(page, base(3));
        await page.goto(`${server!.resolvedUrls.local[0]}#setup`, { waitUntil: "networkidle" });
        const list = page.getByRole("list", { name: "Ways to connect an agent" });
        await list.waitFor({ timeout: 15_000 });
        expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe("How do you want to connect your first agent?");
        const rows = list.getByRole("listitem");
        expect(await rows.count()).toBe(9);
        // Equal rows: every pick button the same width, and the heights within one line of text of each other (a long
        // cost wraps on a phone, which is the row growing for its words, not for its option).
        const boxes = [];
        for (let i = 0; i < 9; i++) boxes.push(await rows.nth(i).getByRole("button").boundingBox());
        const heights = boxes.map((b) => b!.height);
        expect(Math.max(...heights) - Math.min(...heights), `heights ${heights}`).toBeLessThanOrEqual(24);
        expect(new Set(boxes.map((b) => Math.round(b!.width))).size).toBe(1);
        for (const b of boxes) {
          expect(b!.x).toBeGreaterThanOrEqual(0);
          expect(b!.x + b!.width).toBeLessThanOrEqual(p.width + 1);
          if (p.touch) expect(b!.height).toBeGreaterThanOrEqual(44);
        }
        if (out) {
          mkdirSync(out, { recursive: true });
          await list.screenshot({ path: path.join(out, `connect-list-${p.name}.png`) });
        }
        // Nothing is open until the owner picks a row, and picking the Anthropic key keeps the list itself.
        expect(await page.getByText("Save and connect").count()).toBe(0);
        await rows.nth(1).getByRole("button").click(); // Anthropic API key
        await page.getByText("Save and connect").waitFor();
        expect(await page.getByText("platform.claude.com", { exact: false }).count()).toBeGreaterThan(0);
        await page.getByLabel("Anthropic key").fill("sk-ant-oat01-a-setup-token");
        await page.getByText("Save and connect").click();
        const error = page.getByRole("alert").filter({ hasText: "That's a setup token, not an API key" });
        await error.waitFor();
        expect(await page.getByLabel("Anthropic key").getAttribute("aria-describedby")).toBe(await error.getAttribute("id"));
        if (out) await list.screenshot({ path: path.join(out, `connect-key-error-${p.name}.png`) });
        // Opening the plan closes the key's steps, so one short set of steps is shown at a time.
        await rows.nth(0).getByRole("button").click(); // Claude Pro or Max plan
        await page.getByText("Save and connect").waitFor();
        expect(await page.getByText("platform.claude.com", { exact: false }).count()).toBe(0);
        const install = page.getByRole("link", { name: "Claude Code's setup page" });
        expect(await install.getAttribute("href")).toBe("https://code.claude.com/docs/en/setup");
        const box = await install.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(p.width + 1);
        if (out) await list.screenshot({ path: path.join(out, `connect-plan-steps-${p.name}.png`) });
      } finally {
        await page.close();
      }
    });

    it(`${p.name}: a saved key shows connected, and step 7 says to go back until something is saved`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.ratio, hasTouch: p.touch, isMobile: p.touch });
      try {
        await stubApi(page, base(3, { "/api/companies/c1/grants": [{ id: "g1", envName: "ANTHROPIC_API_KEY", secretId: "s1", secretName: "App Co Anthropic API key", hint: "••••abcd", deployTargetId: null, agentIds: [] }] }));
        await page.goto(`${server!.resolvedUrls.local[0]}#setup`, { waitUntil: "networkidle" });
        const status = page.getByRole("status").first();
        await status.waitFor({ timeout: 15_000 });
        expect(await status.textContent()).toContain("Connected");
        expect(await status.textContent()).toContain("Anthropic API key");
        if (out) {
          mkdirSync(out, { recursive: true });
          await page.locator(".connect-list").screenshot({ path: path.join(out, `connect-connected-${p.name}.png`) });
        }
      } finally {
        await page.close();
      }
      // Step 7 on its own: nothing saved, so the line above the form says where it is set up.
      const p7 = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.ratio, hasTouch: p.touch, isMobile: p.touch });
      try {
        await stubApi(p7, base(6, { "/api/companies/c1/projects": API["/api/companies/c1/projects"] }));
        await p7.goto(`${server!.resolvedUrls.local[0]}#setup`, { waitUntil: "networkidle" });
        const hint = p7.getByTestId("setup-funding-hint");
        await hint.waitFor({ timeout: 15_000 });
        expect(await hint.textContent()).toContain("Go back to the connect step; it sets this up for you.");
        const box = await hint.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(p.width + 1);
        // It sits above the funding-source form it explains.
        const form = await p7.getByLabel("New funding source").boundingBox();
        expect(box!.y).toBeLessThan(form!.y);
        if (out) await hint.screenshot({ path: path.join(out, `connect-step7-hint-${p.name}.png`) });
      } finally {
        await p7.close();
      }
    });
  }
});
