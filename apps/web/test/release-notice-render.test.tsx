import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { ReleaseNoticeBody, type ReleaseWatchView } from "../src/pages/settings/ReleaseNotice";

// A rendering check of the "new release available" line in Settings (BOS-2663). It renders the real component with the real
// styles.css in a headless browser at the owner's two devices and a 390 px phone, with a long summary and a long version, and
// checks the line and both switches stay inside their box, the release link is visible, and nothing scrolls sideways.
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean; isMobile?: boolean }) => Promise<Page>;
  close: () => Promise<void>;
};

async function launch(): Promise<Browser | null> {
  let chromium: { launch: (opts?: { executablePath?: string }) => Promise<Browser> };
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
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

const scratch = process.env.BOSSMAN_SCRATCH;
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `release-notice-${name}.png`) : null);

type Active = Extract<ReleaseWatchView, { active: true }>;
const available: Active = {
  active: true,
  current: "0.9.0-beta.3",
  channel: "beta",
  enabled: true,
  ntfy: false,
  checkedAt: "2026-11-26T06:00:00.000Z",
  couldntCheck: false,
  available: {
    version: "0.9.0-beta.4-with-a-rather-long-build-label",
    url: "https://example.com/releases/0.9.0-beta.4",
    summary: "Faster start-up, a calmer Updates panel and a fix for runners that stayed unhealthy after a restart. ".repeat(3).trim(),
    publishedAt: "2026-11-25T10:00:00.000Z",
    prerelease: true,
  },
};
const quiet: Active = { ...available, available: null, couldntCheck: true };

const page = (v: Active) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(<ReleaseNoticeBody v={v} busy={false} set={() => {}} />)}</main></body></html>`;

const read = () => {
  const root = document.querySelector('[data-testid="release-notice"]') as HTMLElement;
  const box = root.getBoundingClientRect();
  const inside = [...root.querySelectorAll("p, label, a, input")].every((e) => {
    const r = e.getBoundingClientRect();
    return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
  });
  const link = root.querySelector("a") as HTMLAnchorElement | null;
  const lr = link?.getBoundingClientRect();
  return {
    text: root.innerText,
    inside,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    linkVisible: !!lr && lr.width > 0 && lr.height > 0,
    href: link?.getAttribute("href") ?? null,
    boxes: root.querySelectorAll("input[type=checkbox]").length,
  };
};

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("release notice in a real browser (BOS-2663)", () => {
  for (const d of devices) {
    it(`${d.name}: the new-release line, its link and both switches fit`, async () => {
      const p = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await p.setContent(page(available), { waitUntil: "load" });
        const got = await p.evaluate(read);
        expect(got.text).toContain("is available");
        expect(got.text).toContain("you run 0.9.0-beta.3");
        expect(got.href).toBe("https://example.com/releases/0.9.0-beta.4");
        expect(got.linkVisible).toBe(true);
        expect(got.boxes).toBe(2);
        expect(got.inside).toBe(true);
        expect(got.overflow).toBeLessThanOrEqual(1);
        const path = await shotPath(d.name);
        if (path) await p.screenshot({ path, fullPage: true });
      } finally {
        await p.close();
      }
    });

    it(`${d.name}: the quiet "couldn't check" line fits`, async () => {
      const p = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await p.setContent(page(quiet), { waitUntil: "load" });
        const got = await p.evaluate(read);
        expect(got.text).toContain("Couldn't check");
        expect(got.inside).toBe(true);
        expect(got.overflow).toBeLessThanOrEqual(1);
      } finally {
        await p.close();
      }
    });
  }
});
