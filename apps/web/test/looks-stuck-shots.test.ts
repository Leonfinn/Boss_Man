import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// Real-browser proof shots of the "Looks stuck" tag, line and strip item (BOS-1910) at desktop and 380 px, plus the
// 0-stuck state (strip item hidden). The assertions always run; the screenshots are written only when BOSSMAN_SCRATCH is set.

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
const out = process.env.BOSSMAN_SCRATCH;
const day = 86_400_000;
const stuck = (days: number) => ({ rule: "stale_in_progress", idleMs: days * day, since: new Date(Date.now() - days * day).toISOString() });
const t = (id: string, state: string, n: number, over: Record<string, unknown> = {}) => ({
  id, title: `Made-up ticket ${n}`, number: n, systemState: state, outcome: null, assigneeAgentId: "a1", assignedToOwner: false, dueDate: null, blockedBy: [], branch: "b", risk: "low", size: 2,
  planFirst: false, plan: null, planApprovedAt: null, featureId: null, body: null, lastActivityAt: new Date().toISOString(), waitingOnOwner: false, reviewStage: null, ...over,
});
const col = (id: string, state: string, tickets: unknown[], wip: number | null = null) => ({ id, name: state, systemState: state, wipLimit: wip, tickets });
const boardWith = (withStuck: boolean) => ({
  project: { id: "p1", companyId: "c1", name: "App" },
  workingAgents: 0,
  withoutTicket: [],
  columns: [
    col("c-ready", "ready", [t("r1", "ready", 1, { nextUp: true })]),
    col("c-prog", "in_progress", [t("p1", "in_progress", 10, withStuck ? { looksStuck: stuck(3) } : {}), t("p2", "in_progress", 11)], 3),
    col("c-blk", "blocked", [t("b1", "blocked", 20, withStuck ? { looksStuck: stuck(1) } : {})]),
    col("c-rev", "review", [t("v1", "review", 30, { reviewStage: "checking" })]),
    col("c-done", "done", []),
  ],
});

describe.skipIf(!can)("Looks stuck shots (BOS-1910)", () => {
  for (const size of [{ name: "desktop-1550", width: 1550, height: 1000, touch: false }, { name: "phone-380", width: 380, height: 844, touch: true }] as const) {
    for (const withStuck of [true, false]) {
      it(`${withStuck ? "shows" : "hides"} looks stuck at ${size.name}`, async () => {
        const page = (await browser!.newPage({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch })) as any;
        await stubApi(page, { ...API, "/api/projects/p1/board": boardWith(withStuck) });
        await page.addInitScript(() => localStorage.setItem("bm-side-collapsed", "1"));
        await page.goto(`${server!.resolvedUrls.local[0]}#board/p1`, { waitUntil: "networkidle" });
        await page.getByRole("group", { name: "Where work stands" }).waitFor({ timeout: 15_000 });
        expect(await page.getByTestId("standing-stuck").count()).toBe(withStuck ? 1 : 0);
        expect(await page.getByTestId("board-looks-stuck-note").count()).toBe(withStuck ? 2 : 0);
        if (withStuck) expect(await page.getByTestId("standing-stuck").textContent()).toContain("2 looks stuck");
        if (out) {
          mkdirSync(out, { recursive: true });
          await page.screenshot({ path: path.join(out, `bos1910-${size.name}-${withStuck ? "stuck" : "none"}.png`), fullPage: true });
        }
        await page.close();
      }, 60_000);
    }
  }
});
