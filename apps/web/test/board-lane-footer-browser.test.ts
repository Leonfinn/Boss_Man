import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi, type Page } from "./real-page";

// BOS-2509: BOS-2400 added "oldest 4 h" to the lane header and "in progress 4 h" to the card footer with no
// screenshot, and on the real board the lane name wrapped, "3 d" split across lines, and the footer text drew over the
// agent's picture. This mounts the real page in Chromium with a lane that has an oldest age and a card in each state
// that shows a time in state, and measures: no line break inside the age, the lane name on one line, the footer text
// clear of the picture. With BOSSMAN_SCRATCH set it saves the shots. Skipped where no browser or Vite is installed.

const browser = await launch();
const server = await startVite();
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const card = (id: string, state: string, n: number, hours: number, extra: Record<string, unknown> = {}) => ({
  id, title: `Ticket ${n} with a title long enough to wrap onto two lines in a card`, number: n, systemState: state, outcome: null,
  assigneeAgentId: "a1", assignedToOwner: false, dueDate: null, blockedBy: [], branch: "b", risk: "low", size: 2, planFirst: false, plan: null,
  planApprovedAt: null, featureId: null, body: null, lastActivityAt: hoursAgo(hours), stateChangedAt: hoursAgo(hours), waitingOnOwner: false,
  reviewStage: state === "review" ? "awaiting_review" : null, ...extra,
});
const col = (i: number, state: string, name: string, tickets: unknown[]) => ({ id: `col${i}`, name, systemState: state, wipLimit: null, tickets });
const board = {
  project: (API["/api/projects/p1/board"] as { project: unknown }).project,
  workingAgents: 0,
  withoutTicket: [],
  columns: [
    col(0, "ready", "Ready", [card("r1", "ready", 1, 3)]),
    col(1, "in_progress", "In progress", [card("i1", "in_progress", 2, 4), card("i2", "in_progress", 3, 30)]),
    col(2, "blocked", "Blocked", [card("b1", "blocked", 4, 1), card("b2", "blocked", 5, 80, { dueDate: "2026-12-01" })]),
    col(3, "review", "Review", [card("v1", "review", 6, 17)]),
    col(4, "done", "Done", [card("d1", "done", 7, 5)]),
  ],
};

async function open(width: number, height: number, touch: boolean): Promise<Page> {
  const page = (await browser!.newPage({ viewport: { width, height }, deviceScaleFactor: touch ? 3 : 1, hasTouch: touch, isMobile: touch })) as Page;
  const api = { ...API, "/api/projects/p1/board": board, "/api/companies": [{ ...(API["/api/companies"] as any[])[0], agents: [{ ...(API["/api/companies"] as any[])[0].agents[0], name: "Bungle - Web Developer" }] }] };
  await stubApi(page, api);
  await page.goto(`${server!.resolvedUrls.local[0]}#board/p1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".board-scroll .ticket h3", { timeout: 15_000 });
  return page;
}

function measure(page: Page) {
  return page.evaluate(() => {
    const box = (e: Element) => e.getBoundingClientRect();
    const lines = (e: Element) => { const r = document.createRange(); r.selectNodeContents(e); return new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top))).size; };
    const heads = Array.from(document.querySelectorAll(".lane-head")).map((h) => {
      const h2 = h.querySelector("h2")!;
      const old = h.querySelector(".lane-oldest");
      return { name: h2.textContent, nameLines: lines(h2), old: old?.textContent ?? null, oldLines: old ? lines(old) : 0, oldBelowTitle: old ? box(old).top >= box(h.querySelector(".lane-title")!).bottom - 1 : true };
    });
    const rows = Array.from(document.querySelectorAll(".ticket .row")).map((r) => {
      const av = r.querySelector(".avatar");
      const end = r.querySelector(".end");
      const texts = Array.from(r.querySelectorAll(".end .mono"));
      const overlap = av ? texts.some((t) => { const a = box(av), b = box(t); return b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top; }) : false;
      const marks = texts.filter((t) => /\d+\s?[hd]\b/.test(t.textContent ?? "")).length;
      return { avatarW: av ? box(av).width : 0, overlap, endRight: end ? box(end).right <= box(r).right + 0.5 : true, marks, split: texts.some((t) => lines(t) > 1) };
    });
    return { heads, rows };
  });
}

const skip = !browser || !server;
const sizes: Array<[string, number, number, boolean]> = [["desktop-1440", 1440, 900, false], ["brave-1667-touch", 1667, 724, true], ["phone-380", 380, 800, true]];

describe.skipIf(skip)("board lane header and card footer (BOS-2509, real page)", () => {
  for (const [label, w, h, touch] of sizes) {
    it(`${label}: lane name on one line, age unbroken under the title, footer clear of the picture, age shown once`, async () => {
      const page = await open(w, h, touch);
      try {
        const dir = process.env.BOSSMAN_SCRATCH;
        if (dir) {
          mkdirSync(dir, { recursive: true });
          await page.screenshot({ path: path.join(dir, `bos-2509-${process.env.BOS_2509_TAG ?? "after"}-${label}.png`), fullPage: false });
        }
        const m: { heads: Array<{ name: string | null; nameLines: number; old: string | null; oldLines: number; oldBelowTitle: boolean }>; rows: Array<{ avatarW: number; overlap: boolean; endRight: boolean; marks: number; split: boolean }> } = await measure(page);
        const withAge = m.heads.filter((x) => x.old);
        expect(withAge.length).toBeGreaterThanOrEqual(3);
        for (const x of m.heads) expect(x.nameLines, `${x.name} stays on one line`).toBe(1);
        for (const x of withAge) {
          expect(x.oldLines, `${x.old} is on one line`).toBe(1);
          expect(x.oldBelowTitle, `${x.old} sits under the title`).toBe(true);
        }
        for (const r of m.rows) {
          expect(r.avatarW).toBeGreaterThanOrEqual(27);
          expect(r.overlap, "footer text does not cover the picture").toBe(false);
          expect(r.endRight).toBe(true);
          expect(r.split).toBe(false);
          expect(r.marks, "the age shows once").toBeLessThanOrEqual(1);
        }
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
