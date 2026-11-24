// @vitest-environment node
// BOS-2531: the update banner says "being swapped now" only while a runner is really being recreated (with a back-by
// time), and "swapped next" when nothing is left to wait for but no runner is mid-swap. Rendered in a real browser
// through Vite with a made-up maintenance reply, on a desktop and a 380px phone. Screenshots go to BOSSMAN_SCRATCH.
// Skipped, not failed, where no browser or Vite is installed.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

const browser = await launch();
const server = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const since = new Date(Date.now() - 600_000).toISOString();
const deadline = new Date(Date.now() + 600_000).toISOString();
const backBy = new Date(Date.now() + 120_000).toISOString();
const base = { on: true, kind: "update", reason: "runner update", since, deadline, runs: 0, companies: 0, checks: 0, phase: "swapping", expectedFinishAt: null, overdue: false };
const midSwap = { ...base, chatOpen: false, chatBackBy: backBy };
const swapNext = { ...base, chatOpen: true, chatBackBy: null };

const shots = process.env.BOSSMAN_SCRATCH;
const banner = async (maintenance: object, width: number, height: number, name: string) => {
  const page = await browser!.newPage({ viewport: { width, height } });
  try {
    await stubApi(page, { ...API, "/api/maintenance": maintenance });
    await page.goto(`${server!.resolvedUrls.local[0]}#/decisions`, { waitUntil: "networkidle" });
    await page.waitForSelector(".banner", { timeout: 15_000 });
    const text = ((await page.textContent(".banner")) ?? "").replace(/\s+/g, " ").trim();
    if (shots) {
      try {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, `${name}.png`) });
      } catch {
        /* a screenshot is not the test */
      }
    }
    return text;
  } finally {
    await page.close();
  }
};

describe.skipIf(!browser || !server)("BOS-2531 update banner: 'being swapped now' only mid-swap", () => {
  it("desktop and phone: a runner mid-swap says swapped now with a back-by time", async () => {
    for (const [w, h, n] of [[1280, 800, "desktop"], [380, 800, "phone"]] as const) {
      const text = await banner(midSwap, w, h, `bos-2531-${n}-mid-swap`);
      expect(text).toContain("swapping the runners now");
      expect(text).toMatch(/swapping the runners now\. Back by \d{1,2}[:.]\d{2}.* at the latest\./);
    }
  });

  it("desktop and phone: nothing left to wait for but no runner mid-swap says the swap is next, never 'now'", async () => {
    for (const [w, h, n] of [[1280, 800, "desktop"], [380, 800, "phone"]] as const) {
      const text = await banner(swapNext, w, h, `bos-2531-${n}-swap-next`);
      expect(text).toContain("about to swap the runners");
      expect(text).toContain("The runners are swapped next.");
      expect(text).not.toContain("swapped now");
      expect(text).not.toContain("swapping the runners now");
    }
  });
});
