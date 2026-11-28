// A rendering check of chat command boxes (BOS-2853). The real MessageText component is rendered to markup
// with the real styles.css and read in a headless browser at the owner's recorded widths (Brave 1667,
// Safari 1550) and a 390 px phone. It checks geometry, not class names: two boxes, monospace, the box inside
// its bubble and the chat log, no sideways page scroll and no overflow inside a box, and a one-line preview
// with no fence lines.
//
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { MessageText } from "../src/components/MessageText";
import { previewText } from "../src/components/MessageText";

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

const SHORT = "docker rm -f $(docker ps -aq --filter name=boss-man)";
const LONG =
  "docker run --rm -it --name boss-man-check --env-file .env -v /srv/boss-man:/srv/boss-man -v /var/run/docker.sock:/var/run/docker.sock --network host ghcr.io/example/boss-man:1.2.3 ./scripts/check-all.sh --full --verbose";
const REPLY = `I cleared it:\n\n\`\`\`sh\n${SHORT}\n\`\`\`\n\nThen check with:\n\n\`\`\`sh\n${LONG}\n\`\`\``;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body><div class="chat-page"><section class="card messenger" data-picked="yes">
<nav class="messenger-list"><ul><li><a href="#"><span class="who"><span class="name">Radagast <small>CEO</small></span><span class="preview">${previewText(REPLY)}</span></span></a></li></ul></nav>
<div class="messenger-chat"><div class="chat-log"><div class="chat-msg assistant">
<div class="msg-text">${renderToStaticMarkup(<MessageText text={REPLY} />)}</div><small>Radagast · now</small>
</div></div></div></section></div></body></html>`;

const measure = () => {
  const boxes = Array.from(document.querySelectorAll(".chat-msg .msg-text [data-command]")) as HTMLElement[];
  const pre = boxes[0]?.querySelector("pre") as HTMLElement | null;
  const bubble = document.querySelector(".chat-msg .msg-text") as HTMLElement | null;
  const log = document.querySelector(".chat-log") as HTMLElement | null;
  const preview = document.querySelector(".messenger-list .preview") as HTMLElement | null;
  const r = pre?.getBoundingClientRect();
  const b = bubble?.getBoundingClientRect();
  const l = log?.getBoundingClientRect();
  return {
    boxes: boxes.length,
    text: boxes.map((el) => el.querySelector("pre")?.textContent ?? ""),
    mono: pre ? /mono/i.test(getComputedStyle(pre).fontFamily) : false,
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    preOverflowX: pre ? pre.scrollWidth - pre.clientWidth : -1,
    insideBubble: !!(r && b && r.left >= b.left - 1 && r.right <= b.right + 1),
    insideLog: !!(r && l && r.right <= l.right + 1),
    copyButtons: document.querySelectorAll('.chat-msg [aria-label="Copy this command"]').length,
    preview: preview?.textContent ?? "",
    previewHeight: preview?.getBoundingClientRect().height ?? -1,
  };
};

const scratch = process.env.BOSSMAN_SCRATCH;
const shots = (name: string) => (scratch ? path.join(scratch, `bos-2853-box-${name}.png`) : null);

const devices = [
  { name: "brave-1667", width: 1667, height: 724, ratio: 3, touch: true },
  { name: "safari-1550", width: 1550, height: 900, ratio: 2, touch: false },
  { name: "phone-390", width: 390, height: 844, ratio: 3, touch: true },
];

describe.skipIf(!browser)("BOS-2853 chat command boxes at the owner's widths", () => {
  for (const d of devices) {
    it(`${d.name}: boxes fit their bubble and the log, and the page has no sideways scroll`, async () => {
      const page = await browser!.newPage({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.ratio, hasTouch: d.touch, isMobile: d.touch });
      try {
        await page.setContent(HTML, { waitUntil: "load" });
        const m = await page.evaluate(measure);
        expect(m.boxes, JSON.stringify(m)).toBe(2);
        expect(m.text).toEqual([SHORT, LONG]);
        expect(m.text.join("\n")).not.toContain("```");
        expect(m.mono, JSON.stringify(m)).toBe(true);
        expect(m.copyButtons).toBe(2);
        expect(m.pageOverflowX, JSON.stringify(m)).toBeLessThanOrEqual(0);
        expect(m.preOverflowX, JSON.stringify(m)).toBeLessThanOrEqual(1);
        expect(m.insideBubble, JSON.stringify(m)).toBe(true);
        expect(m.insideLog, JSON.stringify(m)).toBe(true);
        expect(m.preview).toContain(SHORT);
        expect(m.preview).not.toContain("```");
        expect(m.previewHeight, JSON.stringify(m)).toBeLessThanOrEqual(20);
        const shot = shots(d.name);
        if (shot) {
          try {
            mkdirSync(scratch!, { recursive: true });
            await page.screenshot({ path: shot, fullPage: true });
          } catch {
            /* a screenshot is not the test */
          }
        }
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
