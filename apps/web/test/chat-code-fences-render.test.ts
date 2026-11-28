// @vitest-environment node
// BOS-2853: a fenced command in a chat reply is a real code box with a Copy button, at desktop width and on a
// 390px phone. The fence lines (```sh and ```) never show as text, the long command wraps or scrolls inside its
// box instead of widening the page, and the left-hand thread preview shows the command without the fences.
// The measurements are the test; before/after screenshots go to BOSSMAN_SCRATCH when it is set.
// Skipped, not failed, where no browser or Vite is installed.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi, type Page } from "./real-page";

const browser = await launch();
const server = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const SHORT = "docker rm -f $(docker ps -aq --filter name=boss-man)";
const LONG =
  "docker run --rm -it --name boss-man-check --env-file .env -v /srv/boss-man:/srv/boss-man -v /var/run/docker.sock:/var/run/docker.sock --network host ghcr.io/example/boss-man:1.2.3 ./scripts/check-all.sh --full --verbose";
const REPLY = `I cleared it:\n\n\`\`\`sh\n${SHORT}\n\`\`\`\n\nThen check with:\n\n\`\`\`sh\n${LONG}\n\`\`\``;
const at = "2026-11-27T10:00:00Z";
const last = { role: "assistant", text: REPLY, createdAt: at };
const api = {
  ...API,
  "/api/companies/c1/chat/threads": [{ id: "a1", name: "Radagast", role: "ceo", duty: null, state: "idle", last }],
  "/api/companies/c1/chat": { agentId: "a1", state: "idle", items: [{ id: "m1", role: "assistant", text: REPLY, createdAt: at }] },
};

const open = async (width: number, height: number, touch: boolean): Promise<Page> => {
  const page = await browser!.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  await stubApi(page, api);
  await page.goto(`${server!.resolvedUrls.local[0]}#/chat/c1/a1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".chat-msg", { timeout: 15_000 });
  return page;
};

const measure = () => {
  const boxes = Array.from(document.querySelectorAll(".chat-msg .msg-text [data-command]")) as HTMLElement[];
  const pre = boxes[0]?.querySelector("pre") as HTMLElement | null;
  const bubble = document.querySelector(".chat-msg .msg-text") as HTMLElement | null;
  const log = document.querySelector(".chat-log") as HTMLElement | null;
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
    preview: document.querySelector(".messenger-list .preview")?.textContent ?? "",
  };
};

const shots = process.env.BOSSMAN_SCRATCH;
const tag = process.env.BOS_2853_TAG ?? "after";
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  try {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `bos-2853-${tag}-${name}.png`), fullPage: false });
  } catch {
    /* a screenshot is not the test */
  }
};

const SIZES = [
  { name: "desktop", width: 1280, height: 900, touch: false },
  { name: "phone-390", width: 390, height: 844, touch: true },
];

describe.skipIf(!browser || !server)("BOS-2853 chat command boxes", () => {
  for (const s of SIZES) {
    it(`${s.name}: both commands are boxes that fit, and the preview has no fence lines`, async () => {
      const page = await open(s.width, s.height, s.touch);
      try {
        await page.waitForSelector(".chat-msg .msg-text [data-command] pre", { timeout: 15_000 });
        const m = await page.evaluate(measure);
        expect(m.boxes, JSON.stringify(m)).toBe(2);
        expect(m.text).toEqual([SHORT, LONG]);
        expect(m.text.join("\n")).not.toContain("```");
        expect(m.text.join("\n")).not.toMatch(/^\s*sh\s*$/m);
        expect(m.mono).toBe(true);
        expect(m.copyButtons).toBe(2);
        expect(m.pageOverflowX, JSON.stringify(m)).toBeLessThanOrEqual(0);
        expect(m.preOverflowX, JSON.stringify(m)).toBeLessThanOrEqual(1);
        expect(m.insideBubble, JSON.stringify(m)).toBe(true);
        expect(m.insideLog, JSON.stringify(m)).toBe(true);
        expect(m.preview).toContain(SHORT);
        expect(m.preview).not.toContain("```");
        expect(m.preview.startsWith("sh ")).toBe(false);
        await shot(page, s.name);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  // Saves the shots without measuring, so a "before" run can capture the old rendering where the
  // measurements above would fail. Wherever BOSSMAN_SCRATCH is set (the runner, and CI) it runs.
  it.skipIf(!shots)("saves a screenshot of the reply for before/after evidence when asked", async () => {
    const page = await open(1280, 900, false);
    try {
      await page.waitForSelector(".chat-msg", { timeout: 15_000 });
      await shot(page, "desktop");
    } finally {
      await page.close();
    }
    const phone = await open(390, 844, true);
    try {
      await phone.waitForSelector(".chat-msg", { timeout: 15_000 });
      await shot(phone, "phone-390");
    } finally {
      await phone.close();
    }
  }, 30_000);
});
