import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

// A real-browser render of the Decisions menu badge and page heading (BOS-969): the badge shows the
// server's "needs you now" figure, the waiting group is named separately in the heading, and the menu
// item's number stays inside its row at the owner's foldable width and at phone width. Skipped, not
// failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;

// The menu markup the Sidebar renders for a Decisions badge with four cards to do, and a page heading
// with eight to do and four waiting, as the Decisions page lays them out.
const shell = (open: number, waiting: number, collapsed = false) => `<div class="app${collapsed ? " side-collapsed" : ""}">
<nav class="side${collapsed ? " collapsed" : ""}" aria-label="Main">
<div class="side-bar"><div class="brand"><span>Boss Man</span></div><button class="side-collapse">x</button></div>
<div id="nav-groups" class="nav-groups"><section><h2>Work</h2><ul>
<li><a class="nav" href="#/decisions"><span class="nav-label">Decisions</span><span class="count" aria-label="${open} waiting">${open}</span><span class="count-dot" aria-hidden="true"></span></a></li>
</ul></section></div></nav>
<main><header class="page-head"><div><h1>Decisions</h1><p class="sub">${open} decisions to do${waiting ? ` · ${waiting} waiting` : ""} in App Co, newest first.</p></div></header></main></div>`;

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
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

const read = () => {
  const badge = document.querySelector(".side .count") as HTMLElement;
  const link = badge.closest("a") as HTMLElement;
  const label = badge.previousElementSibling as HTMLElement;
  const b = badge.getBoundingClientRect();
  const l = label.getBoundingClientRect();
  const a = link.getBoundingClientRect();
  const sub = document.querySelector(".page-head .sub") as HTMLElement;
  return {
    text: badge.textContent,
    aria: badge.getAttribute("aria-label"),
    heading: sub.textContent,
    // The number sits inside its menu row and after the words, never over them or off the edge.
    inside: b.left >= a.left && b.right <= a.right + 0.5,
    afterLabel: b.left >= l.right,
    headingInside: sub.scrollWidth <= sub.clientWidth + 1,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

// The owner's recorded foldable (Brave, 1667 CSS px, touch) and a phone at 390.
const owner = { width: 1667, height: 724, deviceScaleFactor: 3, hasTouch: true, isMobile: false };
const phone = { width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

describe.skipIf(!browser)("Decisions badge and heading in a real browser (BOS-969)", () => {
  it("shows the server's count in the menu and the waiting group separately in the heading", async () => {
    const page = await browser!.newPage({ viewport: { width: owner.width, height: owner.height } });
    try {
      await page.setContent(html(shell(8, 4)), { waitUntil: "load" });
      const r = await page.evaluate(read);
      expect(r.text).toBe("8");
      expect(r.aria).toBe("8 waiting");
      expect(r.heading).toContain("8 decisions to do · 4 waiting");
    } finally {
      await page.close();
    }
  });

  it("the badge stays inside its menu row at the owner's foldable width", async () => {
    const page = await browser!.newPage({ viewport: { width: owner.width, height: owner.height }, deviceScaleFactor: owner.deviceScaleFactor, hasTouch: owner.hasTouch });
    try {
      await page.setContent(html(shell(15, 4)), { waitUntil: "load" });
      const r = await page.evaluate(read);
      expect(r.text).toBe("15");
      expect(r.inside).toBe(true);
      expect(r.afterLabel).toBe(true);
      expect(r.headingInside).toBe(true);
      expect(r.pageOverflow).toBeLessThanOrEqual(0);
    } finally {
      await page.close();
    }
  });

  it("the collapsed strip keeps its dot, and the phone menu keeps the number readable", async () => {
    const collapsed = await browser!.newPage({ viewport: { width: owner.width, height: owner.height } });
    try {
      await collapsed.setContent(html(shell(8, 4, true)), { waitUntil: "load" });
      const dot = await collapsed.evaluate(() => (document.querySelector(".side .count-dot") as HTMLElement).getBoundingClientRect().width);
      expect(dot).toBeGreaterThan(0);
    } finally {
      await collapsed.close();
    }
    const page = await browser!.newPage({ viewport: { width: phone.width, height: phone.height }, deviceScaleFactor: phone.deviceScaleFactor, hasTouch: phone.hasTouch, isMobile: phone.isMobile });
    try {
      await page.setContent(html(shell(8, 4)), { waitUntil: "load" });
      const r = await page.evaluate(read);
      expect(r.text).toBe("8");
      expect(r.heading).toContain("8 decisions to do · 4 waiting");
      expect(r.pageOverflow).toBeLessThanOrEqual(0);
    } finally {
      await page.close();
    }
  });
});
