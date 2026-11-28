import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { TrialLines } from "../src/pages/settings/System";
import { updateStatus, wrapUpBannerText, type MaintenanceView, type SelfDeployView } from "../src/pages/settings/updates";

// BOS-2786: the owner queued Build and update runners during a server update's 15-minute trial, and Boss Man wrapped up
// by itself. The top banner and the Updates status box say Boss Man is doing it, when it asks agents to finish, how many
// runs and checks are still finishing, and that there is nothing to press. This renders both with the real styles.css in
// headless Chromium at the owner's two desktop widths and a 380 px phone, and measures: every line inside its box, no
// sideways scroll, the runner time said once in the box, no button in the box. Skipped, not failed, where no browser is
// installed (same pattern as updates-wrap-up-render.test.tsx).

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number } }) => Promise<Page>; close: () => Promise<void> };

async function launch(): Promise<Browser | null> {
  let chromium: { launch: (opts?: { executablePath?: string; args?: string[] }) => Promise<Browser> };
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath, args } : { args });
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

const out = process.env.BOSSMAN_SCRATCH;
const T = (hhmm: string) => `2026-11-27T${hhmm}:00.000Z`;
const view: SelfDeployView = {
  enabled: true,
  pending: false,
  status: { result: "deployed", message: "", target: "server", to_commit: "62e77f40", ended: T("09:59"), started: T("09:57") },
  available: { tip: "62e77f40", deployed: "62e77f40", checkedAt: T("10:05") },
  deployer: { reportedAt: T("10:05"), late: false },
  trial: { endsAt: T("10:14"), seconds: 900 },
  runnerQueue: { pressedAt: T("10:05"), startsAt: T("10:14"), why: "the server update's 15-minute trial" },
};
const run = { runId: "r1", agent: "Parsley - Web Developer", ticket: "BOS-1", ticketTitle: "t", runningForMinutes: 20, sinceWrapUpMinutes: 1, waitingOn: null };
const maint = (tellAt: string, runs: number, checks: number) =>
  ({
    on: true,
    kind: "wrapup",
    deadline: T("10:35"),
    runs,
    checks,
    companies: 1,
    wrapAsked: true,
    notRespondingAfter: 30,
    runsList: Array.from({ length: runs }, (_, i) => ({ ...run, runId: `r${i}` })),
    wrapSince: T("10:05"),
    wrapForUpdate: "runner",
    wrapTie: { since: T("10:05"), by: "boss-man", tellAt, server: { approvedAt: T("09:50"), stage: "live-trial", liveAt: T("09:59"), trialEndsAt: T("10:14") }, runner: { queuedAt: T("10:05"), stage: "queued", startsAt: T("10:14"), why: null } },
  }) as unknown as MaintenanceView;

const states = [
  // Queued at 10:05, under 10 minutes before the trial's end: agents asked at once, 2 runs and 1 merge check left.
  { name: "asked", m: maint(T("10:05"), 2, 1), now: Date.parse(T("10:06")), ask: /asked agents to finish at/ },
  // Queued earlier in the trial: the ask is still to come.
  { name: "ask-to-come", m: maint(T("10:04"), 1, 0), now: Date.parse(T("10:01")), ask: /asks agents to finish/ },
];

const pageHtml = (m: MaintenanceView, now: number) => {
  const st = updateStatus(view, m, null, now);
  const lines = renderToStaticMarkup(<TrialLines trial={view.trial ?? null} wait={null} now={now} queue={view.runnerQueue ?? null} wrapNamesRunner={true} />);
  const buttons = [...(st.primary ? [st.primary] : []), ...st.normal].map((b) => `<button>${b.label}</button>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="main"><p class="banner" role="status" data-testid="banner" style="margin:0 0 16px">${wrapUpBannerText(m as never, now)}</p><section class="panel"><h3>Updates</h3><div class="upd-status ${st.tone}" data-testid="update-status"><span class="tag ${st.tone}">${st.tag}</span><div class="upd-status-body"><p class="upd-say">${st.say}</p><p class="muted" style="font-size:14px">${st.more}</p>${lines}${buttons}</div></div></section></main></body></html>`;
};

const read = () => {
  const inside = (el: Element) => {
    const box = el.getBoundingClientRect();
    return Array.from(el.querySelectorAll("p, span")).every((p) => {
      const r = p.getBoundingClientRect();
      return r.left >= box.left - 1 && r.right <= box.right + 1;
    });
  };
  const boxEl = document.querySelector('[data-testid="update-status"]')!;
  const banner = document.querySelector('[data-testid="banner"]')!;
  const b = banner.getBoundingClientRect();
  return {
    box: boxEl.textContent ?? "",
    banner: banner.textContent ?? "",
    bannerHeight: b.height,
    bannerFits: b.left >= 0 && b.right <= document.documentElement.clientWidth + 1,
    buttons: boxEl.querySelectorAll("button").length,
    insideBox: inside(boxEl),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

describe.skipIf(!browser)("Boss Man's own wrap-up on the banner and the Updates box (BOS-2786)", () => {
  for (const w of [{ name: "brave-1667", width: 1667, height: 724 }, { name: "safari-1550", width: 1550, height: 1611 }, { name: "phone-380", width: 380, height: 844 }]) {
    for (const s of states) {
      it(`${w.name} ${s.name}: says Boss Man does it and when, nothing to press, inside the box, no sideways scroll`, async () => {
        const page = await browser!.newPage({ viewport: { width: w.width, height: w.height } });
        try {
          await page.setContent(pageHtml(s.m, s.now), { waitUntil: "load" });
          const got = await page.evaluate(read);
          for (const text of [got.box, got.banner]) {
            expect(text).toMatch(/Boss Man is holding new work and checks since/);
            expect(text).toMatch(s.ask);
            expect(text).not.toMatch(/you asked/i);
          }
          expect(got.banner).toMatch(/Nothing for you to press/);
          expect(got.banner).toMatch(s.name === "asked" ? /Waiting for 2 runs and 1 check to finish/ : /Waiting for 1 run to finish/);
          // The runner time once in the box (the wrap-up line says it; the trial line leaves it out).
          expect(got.box.split("10:14").length - 1).toBe(1);
          expect(got.buttons).toBe(0);
          expect(got.insideBox).toBe(true);
          expect(got.bannerFits).toBe(true);
          // The banner wraps rather than running off: at most a few lines even on the phone.
          expect(got.bannerHeight).toBeLessThan(w.width < 500 ? 260 : 90);
          expect(got.overflow).toBeLessThanOrEqual(0);
          if (out) {
            mkdirSync(out, { recursive: true });
            await page.screenshot({ path: path.join(out, `bos-2786-${w.name}-${s.name}.png`), fullPage: true });
          }
        } finally {
          await page.close();
        }
      });
    }
  }
});
