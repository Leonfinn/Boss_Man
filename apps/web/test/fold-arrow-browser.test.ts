import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

// BOS-2339: every plain <details> fold-out draws one arrow (right shut, down open), also at phone
// width where the summary becomes a flex box and loses the browser's marker. Folds that draw their
// own (.fold, .detail-row) keep theirs. Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  close: () => Promise<void>;
};
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number } }) => Promise<Page>; close: () => Promise<void> };

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

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>
<details id="plain"><summary>What the score means</summary><p>text</p></details>
<details id="plain-open" open><summary>What Bungle tried first</summary><p>text</p></details>
<details id="fold" class="fold"><summary>A fold</summary><p>text</p></details>
</body></html>`;

const read = () => {
  const arrow = (id: string) => {
    const s = document.querySelector(`#${id} > summary`) as HTMLElement;
    const b = getComputedStyle(s, "::before");
    return { content: b.content, list: getComputedStyle(s).listStyleType };
  };
  return { plain: arrow("plain"), open: arrow("plain-open"), fold: arrow("fold") };
};

describe.skipIf(!browser)("plain fold-outs draw an arrow (BOS-2339)", () => {
  for (const width of [390, 1280]) {
    it(`at ${width}px: right when shut, down when open, native marker hidden, .fold unchanged`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 800 } });
      try {
        await page.setContent(HTML, { waitUntil: "load" });
        const r = await page.evaluate(read);
        expect(r.plain.content).toBe('"▸"');
        expect(r.plain.list).toBe("none");
        expect(r.open.content).toBe('"▾"');
        expect(r.fold.content).toBe('"▸"');
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
