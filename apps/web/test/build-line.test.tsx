// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BuildLine, DetailRow, type BuildResult } from "../src/pages/Ticket";

// The git host's build result on the ticket page (BOS-1418).
afterEach(cleanup);

const base: BuildResult = { state: "passed", failing: [], total: 2, url: "https://example.com/runs/1", sha: "abcdef1234567890" };

describe("BuildLine", () => {
  it("shows nothing when the host reported nothing", () => {
    const { container } = render(<BuildLine ci={null} />);
    expect(container.innerHTML).toBe("");
  });
  it("says passed with a link to the run", () => {
    render(<BuildLine ci={base} />);
    expect(screen.getByTestId("build-result").textContent).toContain("passed");
    const a = screen.getByRole("link", { name: "View run" });
    expect(a.getAttribute("href")).toBe("https://example.com/runs/1");
    expect(a.getAttribute("rel")).toContain("noopener");
  });
  it("names failing checks and says running for pending", () => {
    const { rerender } = render(<BuildLine ci={{ ...base, state: "failed", failing: ["lint", "test"] }} />);
    expect(screen.getByTestId("build-result").textContent).toContain("failed (lint, test)");
    rerender(<BuildLine ci={{ ...base, state: "pending", url: null }} />);
    expect(screen.getByTestId("build-result").textContent).toContain("running");
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("says no checks reported yet for none, and only links ordinary web addresses", () => {
    const { rerender } = render(<BuildLine ci={{ ...base, state: "none", url: null }} />);
    expect(screen.getByTestId("build-result").textContent).toContain("no checks reported yet");
    rerender(<BuildLine ci={{ ...base, url: "javascript:alert(1)" }} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

// Layout check (BOS-1418, CEO condition 5): the real "Changes" fold with the build line, measured and
// photographed in a headless browser at a desktop window and at 380px phone width. Skipped, not failed,
// where no browser is installed. Screenshots are written to BOSSMAN_SCRATCH only, never the repo.
const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
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
const shotPath = scratch ? (await import("node:path")).join(scratch, `build-line-${process.env.BOSSMAN_SHOT_TAG ?? "after"}`) : null;

const failed: BuildResult = { state: "failed", failing: ["lint", "test (apps/server)"], total: 4, url: "https://example.com/runs/42", sha: "abcdef1234567890" };

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
 body { margin: 0; background: var(--bg); } main { padding: 16px; max-width: 900px; margin: 0 auto; }
</style></head><body><div class="app"><main>${renderToStaticMarkup(<DetailRow title="Changes" count="failed" open><BuildLine ci={failed} /></DetailRow>)}</main></div></body></html>`;

type Measure = { resultText: string; linkHref: string | null; scrollWidth: number; innerWidth: number };

const measure = () => {
  const line = document.querySelector('[data-testid="build-result"]') as HTMLElement | null;
  const link = line?.querySelector("a") as HTMLAnchorElement | null;
  return {
    resultText: line?.textContent ?? "",
    linkHref: link?.getAttribute("href") ?? null,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
};

describe.skipIf(!browser)("build line in the Changes fold (BOS-1418)", () => {
  it("desktop 1280: the line shows, with the run link, and nothing overflows sideways", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(html, { waitUntil: "load" });
      const m = (await page.evaluate(measure)) as Measure;
      expect(m.resultText).toContain("failed (lint, test (apps/server))");
      expect(m.linkHref).toBe("https://example.com/runs/42");
      expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
      if (shotPath) await page.screenshot({ path: `${shotPath}-desktop.png`, fullPage: true });
    } finally {
      await page.close();
    }
  });

  it("phone 380: the line wraps inside the fold with no sideways scroll", async () => {
    const page = await browser!.newPage({ viewport: { width: 380, height: 800 }, hasTouch: true, isMobile: true });
    try {
      await page.setContent(html, { waitUntil: "load" });
      const m = (await page.evaluate(measure)) as Measure;
      expect(m.resultText).toContain("failed");
      expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
      if (shotPath) await page.screenshot({ path: `${shotPath}-phone.png`, fullPage: true });
    } finally {
      await page.close();
    }
  });
});
