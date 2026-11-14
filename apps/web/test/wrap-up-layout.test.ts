// Browser rendering check for BOS-988: "Ask agents to wrap up" sits inside the top Runner update box (Updates),
// the separate bottom panel is gone, and it is the main action while an update waits. Runs the real built web app
// in Chromium at a desktop size and the owner's recorded foldable profile, not a CSS-text test.
//
// Skipped, not failed, where the build or a browser is missing. With BOSSMAN_SCRATCH set it also writes
// wrap-up-desktop.png / wrap-up-foldable-<mode>.png there; never into the repo.
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WEB = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(WEB, "dist");
const foldable = JSON.parse(readFileSync(new URL("./device-profiles/owner-brave-foldable.json", import.meta.url), "utf8")) as {
  readings: Array<{ width: number; height: number; pixelRatio: number; coarsePointer: boolean }>;
};
const fp = foldable.readings[0]!;
const built = existsSync(path.join(DIST, "index.html"));

const now = () => new Date().toISOString();
const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [{ id: "a1", companyId: "c1", name: "Radagast", role: "ceo", agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null }], projects: [] };
const runsList = [
  { runId: "r1", agent: "Bungle", ticket: "BOS-957", ticketTitle: "Feature tickbox", runningForMinutes: 34, sinceWrapUpMinutes: 6, waitingOn: null, gotMessage: false, step: { title: "scripts/check-all.sh", sinceMinutes: 14 } },
  { runId: "r2", agent: "Kit", ticket: "BOS-972", ticketTitle: "Claude pack", runningForMinutes: 33, sinceWrapUpMinutes: 6, waitingOn: null, gotMessage: true, step: null },
  { runId: "r3", agent: "Dougal", ticket: "BOS-420", ticketTitle: "Server updates", runningForMinutes: 20, sinceWrapUpMinutes: 6, waitingOn: { question: "May I run the full test suite?", tier: "ceo" } },
  { runId: "r4", agent: "Zebedee", ticket: "BOS-971", ticketTitle: "Multi-arch CI", runningForMinutes: 12, sinceWrapUpMinutes: 6, waitingOn: null },
];
const selfDeploy = {
  enabled: true,
  status: { result: "deployed", target: "server", to_commit: "b6985c93aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ended: now(), started: now(), message: "Deployed." },
  available: { deployed: "b6985c93aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tip: "b6985c93aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", checkedAt: now(), commits: [] },
  pending: false,
  deployer: true,
  lateAfterMinutes: 10,
};
const maintenance = (mode: string) => {
  if (mode === "none") return { on: false, last: null };
  const base = { on: true, kind: "update", reason: "runner update", since: now(), deadline: new Date(Date.now() + 30 * 60000).toISOString(), runs: runsList.length, companies: 1, chatOpen: true, last: null };
  if (mode === "waiting") return base;
  // "late": the wrap-up deadline has passed and the runs are still going.
  if (mode === "late") return { ...base, deadline: new Date(Date.now() - 60000).toISOString(), wrapAsked: true, notRespondingAfter: 30, runsList };
  return { ...base, wrapAsked: true, notRespondingAfter: 30, runsList };
};

function answer(p: string, mode: string): unknown {
  if (p === "/api/setup") return { needsSetup: false };
  if (p === "/api/me") return { username: "owner" };
  if (p === "/api/setup-progress") return { dismissed: true };
  if (p === "/api/companies") return [company];
  if (p === "/api/notifications") return { items: [], unread: 0 };
  if (p === "/api/notifications/unseen") return { count: 0 };
  if (p === "/api/runs" || p === "/api/decisions" || p === "/api/decisions/advised" || p === "/api/decisions/with-team" || p === "/api/decisions/closed-notices") return [];
  if (p === "/api/feedback/unprocessed") return {};
  if (p === "/api/health") return { role: "leader", version: "1.2.0", commit: "b6985c93aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", colour: null, startedAt: now() };
  if (p === "/api/bluegreen") return { enabled: false };
  if (p === "/api/kill-switch") return { paused: false };
  if (p === "/api/maintenance") return maintenance(mode);
  if (p === "/api/runner-report") return { live: [{ slug: "app-co", name: "Boss Man Co", registered: true, connected: true, at: now(), imageVersion: "v1.2", fault: null }], update: { at: now(), title: "Runners updated", body: "All 1 runner is on the new image.", state: "ok", todo: null } };
  if (p === "/api/self-deploy") return selfDeploy;
  if (p === "/api/self-deploy/history") return [
    { id: "h1", target: "server", commit: "b6985c93", changes: 3, result: "deployed", message: null, at: now() },
    { id: "h2", target: "runner", commit: "a1b2c3d4", changes: 0, result: "failed", message: "has not reconnected", at: now() },
  ];
  if (p === "/api/host-facts") return { hostName: "bossman-host", reportedAt: now(), ownerFacts: [], facts: {} };
  if (p === "/api/run-limits") return { instance: 8, company: 4, background: 2, defaults: { instance: 8, company: 4, background: 2 } };
  if (p === "/api/settings/check-queue") return { mode: "legacy", slots: 1, maxSlots: 4, defaultSlots: 1, runnersTooOld: [] };
  if (p === "/api/private-details") return { total: 0, counts: {} };
  if (p === "/api/devices") return [];
  if (p === "/api/netguard-allow") return { report: null };
  return {};
}

let server: Server | undefined;
let base = "";
let mode = "waiting";
const type = (f: string) => (f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".html") ? "text/html" : "application/octet-stream");

beforeAll(async () => {
  server = createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (p.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(p, mode)));
      return;
    }
    const file = path.join(DIST, p === "/" ? "index.html" : p);
    const use = existsSync(file) && !file.endsWith(path.sep) ? file : path.join(DIST, "index.html");
    res.writeHead(200, { "content-type": type(use) });
    createReadStream(use).pipe(res);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

type Page = { evaluate: <T>(fn: () => T) => Promise<T>; on: (ev: string, cb: (a: unknown) => void) => void; setViewportSize: (s: { width: number; height: number }) => Promise<void>; goto: (u: string) => Promise<unknown>; waitForSelector: (s: string, o?: { timeout?: number }) => Promise<unknown>; locator: (s: string) => { boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>; innerText: () => Promise<string>; count: () => Promise<number> }; screenshot: (o: { path: string; fullPage: boolean }) => Promise<unknown>; close: () => Promise<void> };
type Browser = { newPage: (o: { viewport: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean }) => Promise<Page>; close: () => Promise<void> };

async function launch(): Promise<Browser | null> {
  let chromium: { launch: (o?: { executablePath?: string }) => Promise<Browser> };
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const shots = process.env.BOSSMAN_SCRATCH;
const saveShot = (name: string, page: Page) => {
  if (!shots) return;
  try {
    mkdirSync(shots, { recursive: true });
    return page.screenshot({ path: path.join(shots, name), fullPage: false });
  } catch {
    return;
  }
};

describe.skipIf(!built)("BOS-988 wrap-up layout at the owner's sizes", () => {
  it("is inside the Updates box, above the update buttons, with the bottom panel gone, at desktop and foldable", async () => {
    const browser = await launch();
    if (!browser) return; // no browser here: skipped, not passed
    try {
      for (const vp of [{ name: "desktop", width: 1280, height: 800, touch: false, dsf: 1 }, { name: "brave1667", width: 1667, height: 724, touch: true, dsf: 1 }, { name: "phone380", width: 380, height: 800, touch: true, dsf: 2 }, { name: "foldable", width: fp.width, height: fp.height, touch: fp.coarsePointer, dsf: 1 }]) {
        for (const m of ["waiting", "asked", "late", "none"]) {
          mode = m;
          const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dsf, hasTouch: vp.touch });
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(String(e)));
          // The Updates box is on Settings → Server and runner since the Settings menu redesign; #/settings alone is the menu.
          await page.goto(`${base}/#/settings/${company.id}/system`);
          await page.waitForSelector("body", { timeout: 4000 });
          await page.waitForSelector("section.card:has(h2#deploy-h)", { timeout: 8000 });
          await new Promise((r) => setTimeout(r, 1200));
          expect(JSON.stringify(errors), `${vp.name}/${m} page errors`).toBe("[]");
          const updates = page.locator("section.card:has(h2#deploy-h)");
          const box = await updates.boundingBox();
          const sec = "section.card:has(h2#deploy-h)";
          // BOS-1238: one status box, at most one blue main button, nothing wider than the page at any width.
          expect(await page.locator(`${sec} [data-testid='update-status']`).count(), `${vp.name}/${m}: one status box`).toBe(1);
          expect(await page.locator(`${sec} button.primary`).count(), `${vp.name}/${m}: at most one blue button`).toBeLessThanOrEqual(1);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${vp.name}/${m}: nothing runs off the page`).toBeLessThanOrEqual(0);
          expect(box && box.x + box.width <= vp.width + 1, `${vp.name}/${m}: the card fits the window`).toBe(true);
          // The separate bottom "Ask agents to wrap up" panel and the Runner update box are gone.
          expect(await page.locator("section.card:has(h2:has-text('Runner update'))").count(), `${vp.name}/${m}: no Runner update box`).toBe(0);
          const main = await page.locator(`${sec} [data-testid='update-main']`).count();
          if (main) {
            const mb = await page.locator(`${sec} [data-testid='update-main']`).boundingBox();
            // The owner's 1667x724 screen: status box and main button end above the fold; a phone: a tap-sized, full-width button.
            if (vp.name === "brave1667") expect(mb!.y + mb!.height, `${m}: main button above 724`).toBeLessThanOrEqual(724);
            if (vp.name === "phone380") {
              expect(mb!.height, `${m}: tap size`).toBeGreaterThanOrEqual(44);
              const sb = await page.locator(`${sec} [data-testid='update-status']`).boundingBox();
              expect(mb!.width, `${m}: full width`).toBeGreaterThanOrEqual(sb!.width - 2);
            }
          }
          if (m === "none") {
            expect(await page.locator(`${sec} [data-testid='wrapup-box']`).count(), `${vp.name}/${m}: no runs list`).toBe(0);
            expect(await page.locator(`${sec} [data-testid='update-tag']`).innerText()).toBe("Up to date");
          }
          if (m === "waiting") {
            expect(await page.locator(`${sec} [data-testid='update-tag']`).innerText()).toBe("Waiting for agents");
            expect(await page.locator(`${sec} [data-testid='update-main']`).innerText()).toBe("Ask agents to wrap up");
            expect(await page.locator(`${sec} [data-testid='update-say']`).innerText()).toContain("waiting for 4 agents to finish");
          }
          if (m === "late") {
            expect(main, `${vp.name}: main button past the deadline`).toBe(1);
            expect(await page.locator(`${sec} [data-testid='update-main']`).innerText()).toBe("Stop 4 and carry on with the update");
            expect(await page.locator(`${sec} [data-testid='update-next']`).innerText()).toContain("anything they haven't saved is lost");
          }
          if (m === "asked") {
            // Before the deadline there is no main button; the per-run Stop stays.
            expect(main, `${vp.name}: no main button before the deadline`).toBe(0);
            expect(await page.locator(`${sec} button:has-text('Stop this run')`).count()).toBe(4);
            expect(await page.locator(`${sec} [data-testid='wrapup-runs']`).count(), `${vp.name}: still-running list shows`).toBe(1);
            const text = (await page.locator(`${sec} [data-testid='wrapup-runs']`).innerText()).toLowerCase();
            expect(text).toContain("bungle");
            expect(text).toContain("waiting for an answer");
            // BOS-1016: a run in a long step and one that has the message, never "not responding".
            expect(text).toContain("in a long step: it will stop when this step ends");
            expect(text).toContain("running scripts/check-all.sh for 14 min");
            expect(text).toContain("finishing up");
            expect(text).not.toContain("not responding");
          }
          await saveShot(`wrap-up-${vp.name}-${m}.png`, page);
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
