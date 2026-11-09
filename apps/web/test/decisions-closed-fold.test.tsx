import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport, tallestReading } from "@boss-man/shared";
import type { ClosedNoticeCard, Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";

// A rendering check, not a CSS-text test (BOS-809): the owner's Decisions queue was taken over by
// "Closed for you" update cards, each showing its whole "It includes …" paragraph at full size, six
// of them above the one open card. The page now folds those under one "Closed (N)" group at the
// bottom, one line each, and clips the line with an ellipsis. The update card's own ticket list
// shows three and "+N more". This renders the real component to markup and measures it in a
// headless browser at a desktop window and at the owner's recorded foldable profile.
//
// Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const profiles = (() => {
  const dir = new URL("./device-profiles/", import.meta.url);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, parsed: DeviceReport.parse(JSON.parse(readFileSync(new URL(f, dir), "utf8"))) }))
      .filter((p) => p.parsed.readings.length > 0);
  } catch {
    return [];
  }
})();

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
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

// Opt-in before/after proof: with BOSSMAN_SCRATCH set, save full-page screenshots at the desktop
// window and the owner's foldable profile. Never a repo file (the ticket says proofs go to scratch).
const scratch = process.env.BOSSMAN_SCRATCH;
const shot = scratch ? (await import("node:path")).join(scratch, `decisions-closed-${process.env.BOSSMAN_SHOT_TAG ?? "after"}.png`) : null;

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };

const openUpdate = (over: Partial<Decision> = {}): Decision => ({
  id: "open-update",
  companyId: "c1",
  kind: "deploy",
  question: "Boss Man can be updated to the newest version. Approve it?",
  options: ["Update now", "Not now"],
  recommendedOption: "Update now",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "Boss Man Co",
  agentName: null,
  blocks: [],
  score: 40,
  parts: { blocking: 20, urgency: 10, age: 10, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  context: {
    type: "self_deploy",
    update: {
      from: "a1b2c3d4eeff",
      to: "cbe13142aabb",
      total: 12,
      files: 40,
      changes: Array.from({ length: 12 }, (_, i) => ({ ticketId: `t${i}`, ref: `BOS-${760 + i}`, title: `A merged change number ${i + 1} with a reasonably long title` })),
      more: 0,
      otherCommits: [],
      risks: [],
    },
  },
  ...over,
});

const closedNotice = (i: number): ClosedNoticeCard => ({
  id: `closed-${i}`,
  companyId: "c1",
  question: `Main has moved to a${100000 + i}abc. This update has to be applied by hand on the machine that runs Boss Man, so the steps stay on your queue until it's applied or you mark it done. It includes BOS-770; BOS-760; BOS-761; BOS-762; BOS-763; BOS-764; BOS-765; BOS-766; BOS-767; BOS-768; BOS-769; BOS-771: lots of long ticket titles repeated here, which is exactly what filled the screen.`,
  context: {
    handSteps: ["Run the database backup.\n```sh\ndocker compose exec db pg_dump bossman > backup.sql\n```"],
    check: "Open Decisions and look for this card.",
  },
  notice: {
    why: "newer",
    text: `A newer update card covers this one: "Main has moved to a${100001 + i}abc". It brings in everything this one did, so follow that card instead.`,
    at: new Date().toISOString(),
    until: new Date(Date.now() + 3_600_000).toISOString(),
    newer: { decisionId: "open-update", label: `Main has moved to a${100001 + i}abc` },
  },
});

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; } main { padding: 16px; }
</style></head><body><div class="app"><main>${renderToStaticMarkup(
  <Decisions
    decisions={[openUpdate()]}
    companies={[company]}
    loaded
    agentsWorking={0}
    onAnswered={() => {}}
    closedNotices={Array.from({ length: 6 }, (_, i) => closedNotice(i))}
  />,
)}</main></div></body></html>`;

// (BOS-809) The empty-queue case: nothing open, only closed notices. The "Nothing needs you" state
// shows, and the closed notices (kept steps, the link to the newer card) must still be there.
const emptyHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; } main { padding: 16px; }
</style></head><body><div class="app"><main>${renderToStaticMarkup(
  <Decisions
    decisions={[]}
    companies={[company]}
    loaded
    agentsWorking={0}
    onAnswered={() => {}}
    closedNotices={[closedNotice(0), closedNotice(1)]}
  />,
)}</main></div></body></html>`;

type Measure = {
  openTop: number;
  closedTop: number;
  closedCount: number;
  closedOpen: boolean;
  lineHeights: number[];
  singleLine: boolean;
  noteLines: number[];
  updateListItems: number;
  moreButton: string | null;
  waiting: string;
  scrollWidth: number;
  innerWidth: number;
};

const measure = () => {
  const open = document.querySelector(".decision") as HTMLElement;
  const group = document.querySelector(".closed-covers") as HTMLDetailsElement;
  const rows = Array.from(document.querySelectorAll(".closed-covers .covered-line")) as HTMLElement[];
  const summary = group.querySelector(":scope > summary") as HTMLElement;
  const openList = document.querySelector(".decision .deploy-update ul") as HTMLElement;
  const more = document.querySelector(".decision .deploy-update button") as HTMLButtonElement | null;
  // (BOS-809) Requirement 3 is about the squeezed side note that wrapped one word per line. That was
  // the closed card's own note column; folding to one line removed it. The remaining place a kept note
  // is read is .closed-body, which must keep a readable minimum width.
  const note = document.querySelector(".closed-covers .closed-body") as HTMLElement | null;
  return {
    openTop: open.getBoundingClientRect().top,
    closedTop: group.getBoundingClientRect().top,
    closedCount: document.querySelectorAll(".closed-covers [data-closed-card]").length,
    closedOpen: group.open,
    lineHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
    singleLine: rows.every((r) => r.scrollWidth <= r.clientWidth + 1 || getComputedStyle(r).textOverflow === "ellipsis"),
    noteLines: note ? [Math.round(note.getBoundingClientRect().width)] : [],
    updateListItems: openList.querySelectorAll("li").length,
    moreButton: more?.textContent?.trim() ?? null,
    waiting: document.querySelector(".page-head .sub")?.textContent ?? "",
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
};

describe.skipIf(!browser)("closed Decisions cards fold away (BOS-809)", () => {
  it("has a recorded device profile to render at", () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  it("desktop 1280: closed cards sit below the open one, one line each, the update list shows three", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(html, { waitUntil: "load" });
      const m = await page.evaluate(measure) as Measure;
      // The open card is above the closed group, which starts collapsed.
      expect(m.openTop).toBeLessThan(m.closedTop);
      expect(m.closedOpen).toBe(false);
      expect(m.closedCount).toBe(6);
      // Every covered line is a single clipped line (its text is far longer than one line).
      expect(m.singleLine).toBe(true);
      for (const h of m.lineHeights) expect(h).toBeLessThan(40);
      // The update's ticket list shows 3 + "+9 more", not all 12. (Desktop: no 44px tap target.)
      expect(m.updateListItems).toBe(4);
      expect(m.moreButton).toBe("+9 more");
      // Closed cards are not counted as waiting.
      expect(m.waiting).toContain("1 decision waiting");
      // No sideways overflow.
      expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
    } finally {
      await page.close();
    }
  });

  it("the covered line opens to show its steps", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(html, { waitUntil: "load" });
      const before = await page.evaluate(() => document.querySelector(".closed-covers [data-closed-card] details")!.hasAttribute("open"));
      expect(before).toBe(false);
      await page.evaluate(() => (document.querySelector(".closed-covers [data-closed-card] > details > summary") as HTMLElement).click());
      const after = await page.evaluate(() => {
        const d = document.querySelector(".closed-covers [data-closed-card] details") as HTMLDetailsElement;
        return { open: d.open, text: d.textContent ?? "" };
      });
      expect(after.open).toBe(true);
      expect(after.text).toContain("A newer update card covers this one");
      expect(after.text).toContain("Run the database backup");
    } finally {
      await page.close();
    }
  });

  it("empty queue: the closed notices still show under 'Closed (2)' beside the nothing-to-do state", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(emptyHtml, { waitUntil: "load" });
      const r = await page.evaluate(() => {
        const group = document.querySelector(".closed-covers") as HTMLDetailsElement | null;
        return {
          nothingState: document.body.textContent?.includes("Nothing needs you") ?? false,
          summary: group?.querySelector(":scope > summary")?.textContent ?? null,
          groupOpen: group?.open ?? null,
          cards: document.querySelectorAll(".closed-covers [data-closed-card]").length,
        };
      });
      // The "Nothing needs you" state still shows, and the notices below it are not lost.
      expect(r.nothingState).toBe(true);
      expect(r.summary).toBe("Closed (2)");
      expect(r.groupOpen).toBe(false);
      expect(r.cards).toBe(2);
    } finally {
      await page.close();
    }
  });

  it.skipIf(!shot)("saves a before/after screenshot to the scratch folder when asked", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(html, { waitUntil: "load" });
      await page.screenshot({ path: shot!, fullPage: true });
    } finally {
      await page.close();
    }
    expect(shot).toContain("decisions-closed-");
  });

  for (const { file, parsed } of profiles) {
    it(`${file}: the card text keeps a readable width and the covered line stays one line`, async () => {
      const t = tallestReading(parsed);
      const page = await browser!.newPage({ viewport: { width: t.width, height: t.height }, deviceScaleFactor: t.pixelRatio, hasTouch: t.coarsePointer, isMobile: t.coarsePointer });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const m = await page.evaluate(measure) as Measure;
        expect(m.singleLine).toBe(true);
        // One line, not a paragraph: on a touch device the phone tap-target rule (BOS-245) gives
        // every summary a 44px minimum height, so allow that rather than a desktop 40px.
        for (const h of m.lineHeights) expect(h).toBeLessThan(45);
        expect(m.closedCount).toBe(6);
        expect(m.updateListItems).toBe(4);
        expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
        // Requirement 3: open the group and its first closed card; the kept note (.closed-body) must
        // keep a readable minimum width, never a one-word-per-line column.
        const noteWidth = await page.evaluate(() => {
          const group = document.querySelector(".closed-covers") as HTMLDetailsElement;
          group.open = true;
          const card = document.querySelector(".closed-covers [data-closed-card] details") as HTMLDetailsElement;
          card.open = true;
          const body = document.querySelector(".closed-covers .closed-body") as HTMLElement;
          return Math.round(body.getBoundingClientRect().width);
        });
        expect(noteWidth).toBeGreaterThan(240);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
