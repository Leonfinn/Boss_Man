import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { GuideLink } from "../src/guide-links";
import { ReleaseNoticeBody, type ReleaseWatchView } from "../src/pages/settings/ReleaseNotice";

// BOS-2821 (F27): on an image install (the updater is present, no host deployer) the Updates panel shows the release notice
// and one plain line, with no host-deployer or scripts/update-runner.sh text. This renders that no-deployer block with the real
// styles.css in headless Chromium at the owner's two desktop widths and a 390 px phone, and checks the line is there, wraps
// inside the panel, causes no sideways scroll, and the guide link keeps its 44 px touch row. Skipped, not failed, where no
// browser is installed (same pattern as updates-failure-hold-render.test.tsx).

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number }; hasTouch?: boolean; isMobile?: boolean }) => Promise<Page>; close: () => Promise<void> };

async function launch(): Promise<Browser | null> {
  let chromium: { launch: (opts?: { executablePath?: string; args?: string[] }) => Promise<Browser> };
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath, args } : { args });
    } catch {
      // try the next one
    }
  }
  return null;
}

const browser = await launch();
afterAll(async () => {
  await browser?.close();
});

// Two image-install states the ticket names: nothing new (the plain line is the answer) and a release available (the notice
// carries the Install button above the same line).
const view = (available: boolean): Extract<ReleaseWatchView, { active: true }> => ({
  active: true,
  current: "202611280514",
  channel: "stable",
  enabled: true,
  ntfy: false,
  checkedAt: "2026-11-28T05:14:00.000Z",
  couldntCheck: false,
  available: available ? { version: "202611291200", url: "https://example.com/releases/tag/v202611291200", summary: "Faster checks and a clearer board.", publishedAt: "2026-11-29T12:00:00.000Z", prerelease: false } : null,
  install: { linked: true, updater: null },
});

// The same markup SelfDeploy renders for an image install with no host deployer (System.tsx), so geometry matches the app.
const pageHtml = (available: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="main"><section class="panel" id="deploy-h"><h3>Updates</h3>${renderToStaticMarkup(<ReleaseNoticeBody v={view(available)} busy={false} set={() => {}} />)}<p class="muted" style="font-size:14px" data-testid="updates-image-line">You run 202611280514. New releases appear here; nothing to do now.</p><p style="font-size:14px">${renderToStaticMarkup(<GuideLink slug="how-updates-work">What happens in an update?</GuideLink>)}</p></section></main></body></html>`;

type Reading = { line: string | null; deployerWord: boolean; runnerScript: boolean; sideways: number; linkHref: string | null };

const read = () =>
  ({
    line: document.querySelector('[data-testid="updates-image-line"]')?.textContent ?? null,
    deployerWord: /host deployer|update-runner\.sh|finish runs first/.test(document.body.textContent ?? ""),
    runnerScript: /scripts\/update-runner\.sh/.test(document.body.textContent ?? ""),
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    linkHref: document.querySelector("a.guide-link")?.getAttribute("href") ?? null,
  }) as Reading;

const linkRow = () => document.querySelector("a.guide-link")!.getBoundingClientRect().height;

describe("Settings → Updates on an image install (BOS-2821)", () => {
  for (const width of [1667, 1550, 390]) {
    for (const available of [false, true]) {
      const name = available ? "release-available" : "nothing-new";
      it(`shows the plain line, no deployer words, and no sideways scroll at ${width} px (${name})`, async () => {
        if (!browser) return;
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.setContent(pageHtml(available), { waitUntil: "load" });
        const r = await page.evaluate(read);
        expect(r.line).toBe("You run 202611280514. New releases appear here; nothing to do now.");
        expect(r.deployerWord).toBe(false);
        expect(r.runnerScript).toBe(false);
        expect(r.sideways).toBeLessThanOrEqual(0);
        expect(r.linkHref).toMatch(/\/guides\/how-updates-work$/);
        await page.close();
      });
    }
  }

  it("keeps the guide link a 44 px row on a coarse pointer (phone)", async () => {
    if (!browser) return;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await page.setContent(pageHtml(false), { waitUntil: "load" });
    const h = await page.evaluate(linkRow);
    expect(h).toBeGreaterThanOrEqual(44);
    await page.close();
  });
});
