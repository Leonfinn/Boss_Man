import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { launch } from "./real-page";

// BOS-2842: the website What's new page's per-date image badge and the source-vs-image explainer box. Loads the site's
// real styles.css in headless Chromium and measures the badge and the box at desktop and phone widths. It lives in the
// web package only because the browser harness is here; a site test with vitest checks the real build output. Skipped
// where no browser is installed, like the other real-page tests.

const css = readFileSync(new URL("../../site/src/styles.css", import.meta.url), "utf8");
const browser = await launch();
afterAll(async () => {
  await browser?.close();
});

const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><style>${css}</style></head><body>
<div class="wrap guide news">
<main class="g-main">
<h1>What's new</h1>
<p class="g-lead">The changes you will notice in Boss Man, newest first.</p>
<aside class="wn-how" aria-labelledby="wn-how-h">
<h2 id="wn-how-h">When you get each change</h2>
<div class="wn-how-panels">
<section><h3>Built from source</h3><p>You get each change as soon as it is added. Update your server to pick it up.</p></section>
<section><h3>Ready-made Docker image</h3><p>A new image comes out once a week, on Tuesdays, with every change up to then.</p></section>
</div>
<p class="wn-which"><strong>Which do I have?</strong> Open Settings → Server and runner → Updates. An image install says "You run 0.1.0-beta.4".</p>
</aside>
<h2 id="1-december-2026">1 December 2026</h2>
<p class="wn-badge-row"><span class="wn-badge not"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>Not in an image yet</span> <span class="wn-badge-note">comes with the next weekly image (Tuesdays).</span></p>
<ul class="g-list"><li>A later change.</li></ul>
<p class="wn-badge-row split"><a class="wn-badge in" href="https://github.com/Leonfinn/Boss_Man/releases/tag/v0.1.0-beta.4"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.7 8 2l6 2.7v6.6L8 14l-6-2.7z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>In image 0.1.0-beta.4</a></p>
<ul class="g-list"><li>An older change.</li></ul>
</main>
</div></body></html>`;

async function measure(width: number) {
  const page = await browser!.newPage({ viewport: { width, height: 900 } });
  await page.setContent(html, { waitUntil: "load" });
  const m = (await page.evaluate(() => {
    const box = (e: Element) => e.getBoundingClientRect();
    const inBadge = document.querySelector("a.wn-badge.in")!;
    const notBadge = document.querySelector("span.wn-badge.not")!;
    const note = document.querySelector(".wn-badge-note")!;
    const how = document.querySelector(".wn-how")!;
    const panels = Array.from(document.querySelectorAll(".wn-how-panels section"));
    const style = (e: Element) => getComputedStyle(e);
    const ib = style(inBadge);
    const nb = style(notBadge);
    return {
      vw: document.documentElement.clientWidth,
      inBadge: { height: box(inBadge).height, border: ib.borderTopStyle, background: ib.backgroundColor, text: ib.textDecorationLine },
      notBadge: { border: nb.borderTopStyle, background: nb.backgroundColor, text: notBadge.textContent },
      noteColor: style(note).color,
      rows: Array.from(document.querySelectorAll(".wn-badge-row")).map((r) => ({ right: box(r).right, splitBorder: style(r).borderTopStyle })),
      box: { top: box(how).top, right: box(how).right, width: box(how).width },
      panels: {
        columns: style(document.querySelector(".wn-how-panels")!).gridTemplateColumns.split(" ").length,
        tops: panels.map((e) => Math.round(box(e).top)),
        right: Math.max(...panels.map((e) => box(e).right)),
      },
      scrollWidth: document.documentElement.scrollWidth,
    };
  })) as {
    vw: number;
    inBadge: { height: number; border: string; background: string; text: string };
    notBadge: { border: string; background: string; text: string };
    noteColor: string;
    rows: { right: number; splitBorder: string }[];
    box: { top: number; right: number; width: number };
    panels: { columns: number; tops: number[]; right: number };
    scrollWidth: number;
  };
  await page.close();
  return m;
}

describe.skipIf(!browser)("What's new image badge and explainer box", () => {
  it("at 1440px: a 32 px linked badge, a dashed not-yet badge, and two side-by-side explainer panels", async () => {
    const m = await measure(1440);
    expect(m.inBadge.height).toBeGreaterThanOrEqual(30);
    expect(m.inBadge.height).toBeLessThanOrEqual(40);
    expect(m.inBadge.border).toBe("solid");
    expect(m.inBadge.text).toBe("none");
    expect(m.notBadge.border).toBe("dashed");
    expect(m.notBadge.text).toContain("Not in an image yet");
    expect(m.noteColor).toBe("rgb(61, 71, 87)"); // --ink-2
    expect(m.rows.every((r) => r.right <= m.vw)).toBe(true);
    expect(m.rows[1]!.splitBorder).toBe("dashed");
    expect(m.box.right).toBeLessThanOrEqual(m.vw);
    expect(m.panels.columns).toBe(2);
    expect(m.panels.tops[0]).toBe(m.panels.tops[1]);
    expect(m.panels.right).toBeLessThanOrEqual(m.box.right);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.vw);
  });

  it("at 390px: nothing runs off the page and the explainer panels stack", async () => {
    const m = await measure(390);
    expect(m.inBadge.height).toBeGreaterThanOrEqual(30);
    expect(m.inBadge.height).toBeLessThanOrEqual(40);
    expect(m.rows.every((r) => r.right <= m.vw)).toBe(true);
    expect(m.rows[1]!.splitBorder).toBe("dashed");
    expect(m.box.right).toBeLessThanOrEqual(m.vw);
    expect(m.panels.columns).toBe(1);
    expect(m.panels.tops[1]!).toBeGreaterThan(m.panels.tops[0]!);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.vw);
  });
});
