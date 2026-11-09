import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport } from "@boss-man/shared";

// A rendering check of the decision card (BOS-756), not a CSS-text test: a long title stays inside
// the card and the "Ask the CEO for advice" button is spaced from its field, measured in a headless
// browser at a desktop width and at every recorded device profile. Skipped, not failed, where no
// browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const LONG_TITLE = `Boss Man Co has agreed to do "URGENT: HolidayHours agents can't log in to our Umami (analytics.sub-site.com) since the migration started on Monday morning" for HolidayHours, with no cost cap. Approve the work?`;

const body = (title: string) => `
<div class="meta"><span>Raised 8 Nov at 15:33</span></div>
<p class="rec"><strong>RECOMMENDED</strong> Approve</p>
<div class="actions"><button type="button" class="btn primary">Approve</button><button type="button" class="btn">Reject</button></div>
<details class="advice" open>
  <summary>Not enough detail?</summary>
  <div class="advice-row">
    <div class="field">
      <label>What's unclear (optional, one line)</label>
      <input type="text" value="this is fixed now close the ticket" />
    </div>
    <div class="actions"><button type="button" class="btn">Ask the CEO for advice</button></div>
  </div>
</details>`;

const HTML = (title: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body { margin: 0; } main { padding: 20px; }
</style></head><body><main>
<ul class="queue"><li class="decision">
<div class="score"><b>0</b><div class="parts" aria-hidden="true"><span style="width:2px"></span></div></div>
<div class="body"><div><span class="tag">ENGAGEMENT</span></div>
<h2 style="white-space: pre-wrap">${title}</h2>
${body(title)}
</div></li></ul>
</main></body></html>`;

const profiles = (() => {
  const dir = new URL("./device-profiles/", import.meta.url);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, parsed: DeviceReport.parse(JSON.parse(readFileSync(new URL(f, dir), "utf8"))) }))
      .map((p) => {
        const r = p.parsed.readings.find((x) => x.afterScroll) ?? p.parsed.readings[0]!;
        return { file: p.file, width: r.width, height: r.height, deviceScaleFactor: r.pixelRatio, hasTouch: r.coarsePointer };
      });
  } catch {
    return [];
  }
})();

type Box = { x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number };
type Page = {
  setViewportSize: (v: { width: number; height: number }) => Promise<void>;
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
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

type Measured = {
  cardRight: number;
  titleRight: number;
  titleBottom: number;
  titleLines: number;
  inputBottom: number;
  inputRight: number;
  askTop: number;
  askLeft: number;
  approveLeft: number;
  askHeight: number;
  approveHeight: number;
  pageOverflow: number;
};

async function measure(page: Page, title: string, width: number, height: number): Promise<Measured> {
  await page.setViewportSize({ width, height });
  await page.setContent(HTML(title), { waitUntil: "load" });
  return page.evaluate<Measured, void>(() => {
    const card = document.querySelector(".decision")!.getBoundingClientRect();
    const h2 = document.querySelector(".decision h2")!;
    const titleBox = h2.getBoundingClientRect();
    const style = getComputedStyle(h2);
    const lineHeight = parseFloat(style.lineHeight);
    const input = document.querySelector(".advice .field input")!.getBoundingClientRect();
    const ask = [...document.querySelectorAll(".btn")].find((b) => b.textContent === "Ask the CEO for advice")!.getBoundingClientRect();
    const approve = [...document.querySelectorAll(".btn")].find((b) => b.textContent === "Approve")!.getBoundingClientRect();
    return {
      cardRight: card.right,
      titleRight: titleBox.right,
      titleBottom: titleBox.bottom,
      titleLines: Math.round(titleBox.height / lineHeight),
      inputBottom: input.bottom,
      inputRight: input.right,
      askTop: ask.top,
      askLeft: ask.left,
      approveLeft: approve.left,
      askHeight: ask.height,
      approveHeight: approve.height,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

function check(name: string, m: Measured, narrow: boolean) {
  // The title wraps inside the card, on more than one line, and never reaches past its right edge.
  expect(m.titleLines, `${name}: title wraps`).toBeGreaterThan(1);
  expect(m.titleRight, `${name}: title inside card`).toBeLessThanOrEqual(m.cardRight - 8);
  expect(m.pageOverflow, `${name}: nothing runs off the page`).toBeLessThanOrEqual(0);
  // The ask button is not glued to the input: a normal gap (the card's actions use 8px), and either
  // below the field with that gap or beside it.
  const beside = m.askTop < m.inputBottom;
  if (beside) {
    expect(m.askLeft, `${name}: beside the field, after it`).toBeGreaterThan(0);
  } else {
    expect(m.askTop - m.inputBottom, `${name}: gap under the field`).toBeGreaterThanOrEqual(7);
  }
  // It reads as a normal button: same height as Approve, and it shares Approve's left edge, or sits
  // at the field's right end on the same row with that gap.
  expect(Math.abs(m.askHeight - m.approveHeight), `${name}: same height as Approve`).toBeLessThanOrEqual(1);
  if (beside) {
    expect(m.askLeft - m.inputRight, `${name}: gap after the field`).toBeGreaterThanOrEqual(7);
  } else {
    expect(Math.abs(m.askLeft - m.approveLeft), `${name}: left edge lines up with Approve`).toBeLessThanOrEqual(1);
  }
}

describe.skipIf(!browser)("decision card layout (BOS-756)", () => {
  it("wraps a long title inside the card and spaces the advice button, at desktop 1280", async () => {
    const page = await browser!.newPage();
    try {
      check("desktop", await measure(page, LONG_TITLE, 1280, 800), false);
    } finally {
      await page.close();
    }
  });

  it("does the same at a short title (no regression for ordinary cards)", async () => {
    const page = await browser!.newPage();
    try {
      const m = await measure(page, "Approve the work?", 1280, 800);
      expect(m.titleRight).toBeLessThanOrEqual(m.cardRight - 8);
      expect(m.pageOverflow).toBeLessThanOrEqual(0);
      // The advice row still lines up the same way; only the title length differs.
      const beside = m.askTop < m.inputBottom;
      if (beside) expect(m.askLeft - m.inputRight).toBeGreaterThanOrEqual(7);
      else expect(m.askTop - m.inputBottom).toBeGreaterThanOrEqual(7);
    } finally {
      await page.close();
    }
  });

  for (const p of profiles) {
    it(`does the same at ${p.file} (${p.width}x${p.height})`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.deviceScaleFactor, hasTouch: p.hasTouch });
      try {
        check(p.file, await measure(page, LONG_TITLE, p.width, p.height), p.width <= 640);
      } finally {
        await page.close();
      }
    });
  }
});
