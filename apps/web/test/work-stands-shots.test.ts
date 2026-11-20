import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// Real-browser proof shots of the Where work stands strip and the parked lanes (BOS-1909), at Safari 1550,
// the owner's Brave foldable and a 390 px phone. Without BOSSMAN_SCRATCH, a browser or Vite the file skips.

const foldable = JSON.parse(readFileSync(new URL("./device-profiles/owner-brave-foldable.json", import.meta.url), "utf8")) as {
  readings: Array<{ width: number; units: { vh: number }; coarsePointer: boolean }>;
};
const fp = foldable.readings[0]!;
const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server && process.env.BOSSMAN_SCRATCH);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
const out = process.env.BOSSMAN_SCRATCH;
const SIZES = [
  { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "safari-1550", width: 1550, height: 1611, touch: false },
  { name: "brave-1667", width: fp.width, height: fp.units.vh, touch: fp.coarsePointer },
] as const;

const day = 86_400_000;
const t = (id: string, state: string, n: number, over: Record<string, unknown> = {}) => ({
  id, title: `Made-up ticket ${n}`, number: n, systemState: state, outcome: null, assigneeAgentId: "a1", assignedToOwner: false, dueDate: null, blockedBy: [], branch: "b", risk: "low", size: 2,
  planFirst: false, plan: null, planApprovedAt: null, featureId: null, body: null, lastActivityAt: new Date().toISOString(), waitingOnOwner: false, reviewStage: null, ...over,
});
const watch = (n: number, endsInDays: number) =>
  t(`w${n}`, "blocked", 300 + n, { mergeCommit: "abc", watchingFor: "no new errors", watchUntil: "x", watchEndsAt: new Date(Date.now() + endsInDays * day).toISOString() });
const col = (id: string, state: string, tickets: unknown[], wip: number | null = null) => ({ id, name: state, systemState: state, wipLimit: wip, tickets });
const board = {
  project: { id: "p1", companyId: "c1", name: "App" },
  workingAgents: 0,
  withoutTicket: [],
  columns: [
    col("c-ready", "ready", [t("r1", "ready", 1, { nextUp: true }), t("r2", "ready", 2), t("r3", "ready", 3, { nextUp: true })]),
    col("c-prog", "in_progress", [t("p1", "in_progress", 10), t("p2", "in_progress", 11)], 3),
    col("c-blk", "blocked", [t("b1", "blocked", 20), ...[1, 2, 3, 4, 5, 6].map((n, i) => watch(n, i === 3 ? -3 : 10 + n))]),
    col("c-rev", "review", [t("v1", "review", 30, { reviewStage: "checking" }), t("v2", "review", 31, { reviewStage: "checking" }), t("v3", "review", 32, { reviewStage: "awaiting_review" })]),
    col("c-done", "done", []),
  ],
};

describe.skipIf(!can)("Where work stands shots (BOS-1909)", () => {
  for (const size of SIZES) {
    it(`shows the strip and parked lanes at ${size.name}`, async () => {
      const page = (await browser!.newPage({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch })) as any;
      await stubApi(page, { ...API, "/api/projects/p1/board": board });
      await page.addInitScript(() => localStorage.setItem("bm-side-collapsed", "1"));
      await page.goto(`${server!.resolvedUrls.local[0]}#board/p1`, { waitUntil: "networkidle" });
      await page.getByRole("group", { name: "Where work stands" }).waitFor({ timeout: 15_000 });
      expect(await page.getByRole("button", { name: /Show 2 more/ }).count()).toBe(1);
      mkdirSync(out!, { recursive: true });
      await page.screenshot({ path: path.join(out!, `bos1909-${size.name}-top.png`), fullPage: false });
      await page.screenshot({ path: path.join(out!, `bos1909-${size.name}-full.png`), fullPage: true });
      const heights = await page.evaluate(() => [...document.querySelectorAll("[data-testid^='standing-']")].map((e) => Math.round(e.getBoundingClientRect().height)));
      expect(heights.length).toBeGreaterThan(0);
      if (size.touch) expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
      await page.close();
    }, 60_000);
  }
});
