import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// Real-browser checks and proof shots for UI quick wins 4 (BOS-1126): the Board header and pencil
// tooltip (Q10), Roadmap intro/Milestones chevron/progress (Q13), Funding → Budgets spacing (Q14)
// and the ticket page's Hide button (Q15). The Decisions score column (Q7) is already gone (BOS-1236)
// and the Settings menu (Q8) is render-tested in settings-layout.test.ts. The layout tests run always;
// with BOSSMAN_SCRATCH set, the same screens are saved at wide, foldable and phone sizes.
//
// Skipped, not failed, where no browser or Vite is installed (the runner and CI have both).

const foldable = JSON.parse(readFileSync(new URL("./device-profiles/owner-brave-foldable.json", import.meta.url), "utf8")) as {
  readings: Array<{ width: number; height: number; pixelRatio: number; coarsePointer: boolean; units: { vh: number } }>;
};
const fp = foldable.readings[0]!;
const now = new Date().toISOString();

const base = API["/api/projects/p1/board"] as { columns: Array<{ systemState: string; tickets: unknown[] }> };
const one = base.columns[1]!.tickets[0] as object;
const TICKET = "tq";
const ticket = { ...one, id: TICKET, title: "UI quick wins 4: one-screen tidy-ups", number: 1126, systemState: "in_progress" };

const feature = (id: string, title: string, column: string, done: number, total: number) => ({
  id,
  title,
  status: "in_progress",
  rank: 2,
  horizon: column === "now" ? "now" : column === "next" ? "next" : "later",
  column,
  priority: 3,
  releasedAt: null,
  objective: { id: "o1", title: "Polish the owner's screens", priority: 2 },
  publicSummary: null,
  showPublicly: false,
  tickets: { total, done },
  milestones: [{ id: `m-${id}`, title: "Beta", targetDate: "2026-12-01", pinned: null }],
});
const roadmapFeatures = [{ id: "c1", name: "Boss Man Co", features: [feature("f1", "Calmer status tags", "now", 1, 2), feature("f2", "Shorter page intros", "next", 0, 3)] }];
const roadmapTimeline = [
  {
    id: "c1",
    name: "Boss Man Co",
    objectives: [
      {
        id: "o1",
        title: "Polish the owner's screens",
        priority: 2,
        status: "active",
        keyResults: [],
        milestones: [{ id: "m1", title: "Beta", targetDate: "2026-12-01", total: 2, done: 1, blocked: 0, active: 1, status: "on_track", horizon: "now", pinned: null }],
      },
    ],
  },
];

const api: Record<string, unknown> = {
  ...API,
  [`/api/tickets/${TICKET}`]: { ...ticket, companyId: "c1", projectId: "p1", project: "Development", body: "Tidy up six owner screens.", acceptanceCriteria: [], createdAt: now, lastActivityAt: now, landing: "merge", defaultBranch: "main", repoUrl: null, milestoneId: null },
  [`/api/tickets/${TICKET}/related`]: { feature: null, parent: null, subtasks: [], peers: [], waitsOn: [], blocks: [], mentioned: [] },
  [`/api/tickets/${TICKET}/reviews`]: [],
  [`/api/tickets/${TICKET}/artifacts`]: [],
  [`/api/tickets/${TICKET}/images`]: [],
  [`/api/tickets/${TICKET}/runs`]: [],
  [`/api/tickets/${TICKET}/links`]: { waitsOn: [], blocks: [] },
  "/api/roadmap/features": roadmapFeatures,
  "/api/roadmap": roadmapTimeline,
  // TicketLinks reads the objectives as a plain array (the Roadmap page reads /api/roadmap instead).
  "/api/companies/c1/objectives": [],
  "/api/companies/c1/open-tickets": [],
  "/api/risk-tiers": [],
  "/api/projects/p1/spend": {
    tokens: { month: { input: 1200000, output: 340000 }, total: { input: 8000000, output: 2100000 } },
    monthMicros: 4200000,
    totalMicros: 31000000,
    ticketCostCapMicros: 5000000,
    monthlyCapMicros: 50000000,
    monthStart: now,
    topTickets: [
      { id: "a", title: "UI quick wins 4", micros: 1800000 },
      { id: "b", title: "Features table", micros: 900000 },
    ],
  },
};

const browser = await launch();
const vite = browser ? await startVite() : null;
const can = !!(browser && vite);
afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const saveShot = async (name: string, page: any) => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name), fullPage: true });
};

const SHOTS = [
  { name: "desktop", width: 1550, height: 1594, touch: false },
  { name: "foldable", width: fp.width, height: fp.units.vh, touch: fp.coarsePointer },
  { name: "phone", width: 390, height: 844, touch: true },
];
const SCREENS = [
  { name: "board", hash: "#board/p1", wait: ".board-scroll .ticket h3" },
  { name: "roadmap", hash: "#roadmap/features", wait: "text=Milestones" },
  { name: "budgets", hash: "#settings/c1/funding", wait: "text=Most expensive tasks" },
  { name: "ticket", hash: `#tickets/${TICKET}`, wait: ".props-toggle" },
];

async function open(hash: string, size: (typeof SHOTS)[number], wait: string) {
  const page = (await browser!.newPage({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch })) as any;
  await stubApi(page, api);
  await page.goto(`${vite!.resolvedUrls.local[0]}${hash}`, { waitUntil: "networkidle" });
  await page.waitForSelector(wait, { timeout: 15_000 });
  await page.waitForTimeout(400);
  return page;
}

describe.skipIf(!can)("UI quick wins 4 proof shots (BOS-1126)", () => {
  for (const screen of SCREENS) {
    for (const size of SHOTS) {
      it.skipIf(!out)(`${screen.name} at ${size.name}`, async () => {
        const page = await open(screen.hash, size, screen.wait);
        await saveShot(`qw4-${screen.name}-${size.name}.png`, page);
        await page.close();
      }, 60_000);
    }
  }

  it.skipIf(!out || !existsSync(path.join(out)))("saved the shots to the scratch folder", () => {});
});

describe.skipIf(!can)("UI quick wins 4 layout (BOS-1126)", () => {
  it("Q10: the Board hint is the pencil's tooltip and the watchdog pill sits under the project name", async () => {
    const page = await open("#board/p1", SHOTS[0]!, ".board-scroll .ticket h3");
    try {
      // No permanent "Rename a column with its pencil…" line anywhere on the board.
      expect(await page.getByText(/Rename a column with its pencil/).count()).toBe(0);
      // The pencil carries it as its tooltip.
      const pencil = page.locator("button[aria-label^='Rename the']").first();
      expect(await pencil.getAttribute("title")).toMatch(/Rename this column/);
      // The watchdog is a small pill on the line under the project name, inside the header, not floating beside it.
      const h1 = await page.locator(".page-head h1").first().boundingBox();
      const pill = page.locator(".page-head .tag[aria-label='Watchdog health']");
      expect(await pill.count()).toBe(1);
      const pb = await pill.boundingBox();
      expect(pb!.y, "pill is below the name").toBeGreaterThan(h1!.y + h1!.height - 1);
      expect(pb!.y, "pill is on the line right under the name").toBeLessThan(h1!.y + h1!.height + 40);
    } finally {
      await page.close();
    }
  });

  it("Q13: the Roadmap says its intro once, has a labelled Milestones chevron, and reads Not started at 0", async () => {
    const page = await open("#roadmap/features", SHOTS[0]!, "text=Milestones");
    try {
      expect(await page.getByText(/Features grouped by objective/).count(), "title intro is gone").toBe(0);
      expect(await page.getByText(/Features in Now, Next and Later/).count(), "intro said once, under the tabs").toBe(1);
      const fold = page.locator(".rm-unfold").first();
      expect(await fold.getAttribute("aria-label")).toMatch(/milestones for/);
      expect((await fold.innerText()).trim(), "the chevron is labelled Milestones").toMatch(/Milestones/);
      expect(await page.getByText("Not started", { exact: true }).count(), "0 done reads Not started").toBeGreaterThan(0);
      expect(await page.getByText("1 of 2 done", { exact: true }).count(), "partial reads n of m done").toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  it("Q14: Budgets gives the Tokens and Most expensive tasks sub-headings the usual 24 px gap above", async () => {
    const page = await open("#settings/c1/funding", SHOTS[0]!, "text=Most expensive tasks");
    try {
      for (const name of ["Tokens", "Most expensive tasks"]) {
        const top = await page.getByRole("heading", { name, exact: true }).evaluate((el: Element) => parseFloat(getComputedStyle(el).marginTop));
        expect(top, `${name} gap above`).toBe(24);
      }
    } finally {
      await page.close();
    }
  });

  it("Q15: the ticket page's Hide button is the normal outline button, not a grey fill", async () => {
    const page = await open(`#tickets/${TICKET}`, SHOTS[0]!, ".props-toggle");
    try {
      const btn = page.locator(".props-toggle");
      expect((await btn.innerText()).trim()).toBe("Hide");
      const style = await btn.evaluate((el: Element) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, card: (() => { const p = document.createElement("div"); p.style.background = "var(--card)"; document.body.appendChild(p); const v = getComputedStyle(p).backgroundColor; p.remove(); return v; })(), border: cs.borderTopWidth };
      });
      expect(style.bg, "outline button keeps the card background, not a grey fill").toBe(style.card);
      expect(style.border, "outline button keeps its border").not.toBe("0px");
    } finally {
      await page.close();
    }
  });
});
