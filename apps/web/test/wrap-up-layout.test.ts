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
  { runId: "r1", agent: "Bungle", ticket: "BOS-957", ticketTitle: "Feature tickbox", runningForMinutes: 34, sinceWrapUpMinutes: 6, waitingOn: null },
  { runId: "r2", agent: "Kit", ticket: "BOS-972", ticketTitle: "Claude pack", runningForMinutes: 33, sinceWrapUpMinutes: 6, waitingOn: null },
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
  return { ...base, wrapAsked: true, notRespondingAfter: 10, runsList };
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

type Page = { on: (ev: string, cb: (a: unknown) => void) => void; setViewportSize: (s: { width: number; height: number }) => Promise<void>; goto: (u: string) => Promise<unknown>; waitForSelector: (s: string, o?: { timeout?: number }) => Promise<unknown>; locator: (s: string) => { boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>; innerText: () => Promise<string>; count: () => Promise<number> }; screenshot: (o: { path: string; fullPage: boolean }) => Promise<unknown>; close: () => Promise<void> };
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
      for (const vp of [{ name: "desktop", width: 1280, height: 800, touch: false, dsf: 1 }, { name: "foldable", width: fp.width, height: fp.height, touch: fp.coarsePointer, dsf: 1 }]) {
        for (const m of ["waiting", "asked", "none"]) {
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
          const wrap = page.locator("section.card:has(h2#deploy-h) [data-testid='wrapup-box']");
          if ((await wrap.count()) === 0) throw new Error(`no wrap-up action in the Updates box ${vp.name}/${m}: ${(await updates.innerText()).slice(0, 500)}`);
          expect(await wrap.count(), `${vp.name}/${m}: wrap-up is inside the Updates box`).toBe(1);
          // The separate bottom "Ask agents to wrap up" panel is gone.
          expect(await page.locator("section.card:has(h2:has-text('Ask agents to wrap up'))").count(), `${vp.name}/${m}: no bottom panel`).toBe(0);
          const wb = await wrap.boundingBox();
          expect(wb && box && wb.y >= box.y && wb.y <= box.y + box.height, `${vp.name}/${m}: the action sits in the box`).toBe(true);
          const sec = "section.card:has(h2#deploy-h)";
          if (m === "waiting") {
            // The main action is present while an update waits, and the plain wording names the count and when it starts.
            expect(await page.locator(`${sec} button:has-text('Ask agents to wrap up')`).count(), `${vp.name}: ${(await updates.innerText()).slice(0, 400)}`).toBeGreaterThan(0);
            const line = await page.locator(`${sec} [data-testid='wrapup-waiting']`).innerText();
            expect(line).toContain("still running");
            expect(line).toContain("starts when they have finished");
            expect(line).not.toContain("above");
          }
          if (m === "asked") {
            expect(await page.locator(`${sec} [data-testid='wrapup-runs']`).count(), `${vp.name}: still-running list shows`).toBe(1);
            const text = (await page.locator(`${sec} [data-testid='wrapup-runs']`).innerText()).toLowerCase();
            expect(text).toContain("bungle");
            expect(text).toContain("waiting for an answer");
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
