import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { TrialLines } from "../src/pages/settings/System";
import { updateStatus, type MaintenanceView, type SelfDeployView } from "../src/pages/settings/updates";

// BOS-2672 (RCA-011): 26 Nov 11:45 the Updates status box said "You asked agents to wrap up at 11:29 and no update was waiting"
// and, directly under it in the same box, "Runners will update at 11:47". This renders the box as SelfDeploy composes it (the
// wrap-up row's sentence and grey line from updateStatus, then TrialLines) with the real styles.css in headless Chromium at the
// owner's two desktop widths and a 380 px phone, and checks: the runner time once, "no update was waiting" only with no update
// line beside it, every line inside the box, no sideways scroll. It renders the box by hand, not the whole Settings page.
// Skipped, not failed, where no browser is installed (same pattern as updates-failure-hold-render.test.tsx).

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
const NOW = Date.parse("2026-11-26T11:45:00.000Z");
const T = (hhmm: string) => `2026-11-26T${hhmm}:00.000Z`;
const view: SelfDeployView = {
  enabled: true,
  pending: false,
  status: { result: "deployed", message: "", target: "server", to_commit: "329bf446", ended: T("11:32"), started: T("11:29") },
  available: { tip: "329bf446", deployed: "329bf446", checkedAt: T("11:44") },
  deployer: { reportedAt: T("11:44"), late: false },
  trial: { endsAt: T("11:47"), seconds: 900 },
  runnerQueue: { pressedAt: T("11:40"), startsAt: T("11:47"), why: "the server update's 15-minute trial" },
};
const run = { runId: "r1", agent: "Parsley - Web Developer", ticket: "BOS-1", ticketTitle: "t", runningForMinutes: 20, sinceWrapUpMinutes: 16, waitingOn: null };
const wrapup = (wrapTie: Record<string, unknown>) => ({ on: true, kind: "wrapup", deadline: T("11:59"), runs: 1, companies: 1, wrapAsked: true, notRespondingAfter: 30, runsList: [run], wrapSince: T("11:29"), wrapForUpdate: "runner", wrapTie }) as unknown as MaintenanceView;

const states: { name: string; maint: MaintenanceView; v: SelfDeployView; names: RegExp; noneWaiting: boolean }[] = [
  // Row E: the 26 Nov screen. The wrap-up names the runner update and its time; the box's own runner line is left out.
  { name: "trial-runner-queued", maint: wrapup({ since: T("11:29"), server: { approvedAt: T("11:28"), stage: "live-trial", liveAt: T("11:32"), trialEndsAt: T("11:47") }, runner: { queuedAt: T("11:40"), stage: "queued", startsAt: T("11:47") } }), v: view, names: /runner update/, noneWaiting: false },
  // Row F: on trial, nothing queued. The box's own trial line stays (it is about the same update, and doesn't contradict it).
  { name: "trial-nothing-queued", maint: wrapup({ since: T("11:29"), server: { approvedAt: T("11:28"), stage: "live-trial", liveAt: T("11:32"), trialEndsAt: T("11:47") } }), v: { ...view, runnerQueue: null }, names: /server update/, noneWaiting: false },
  // Row A: nothing under way. "No update was waiting", with no update line anywhere in the box.
  { name: "nothing-tied", maint: wrapup({ since: T("11:29"), liftsAt: T("12:29") }), v: { ...view, trial: null, runnerQueue: null }, names: /No update was waiting/, noneWaiting: true },
];

const pageHtml = (maint: MaintenanceView, v: SelfDeployView) => {
  const st = updateStatus(v, maint, null, NOW);
  const wrap = maint as unknown as { wrapTie?: { runner?: unknown } };
  const lines = renderToStaticMarkup(<TrialLines trial={v.trial ?? null} wait={null} now={NOW} queue={v.runnerQueue ?? null} wrapNamesRunner={!!wrap.wrapTie?.runner} />);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="main"><section class="panel"><h3>Updates</h3><div class="upd-status ${st.tone}" data-testid="update-status"><span class="tag ${st.tone}">${st.tag}</span><div class="upd-status-body"><p class="upd-say">${st.say}</p><p class="muted" style="font-size:14px">${st.more}</p>${lines}</div></div></section></main></body></html>`;
};

const read = () => {
  const boxEl = document.querySelector('[data-testid="update-status"]')!;
  const box = boxEl.getBoundingClientRect();
  const text = boxEl.textContent ?? "";
  const ps = Array.from(boxEl.querySelectorAll("p"));
  return {
    text,
    runnerTimes: text.split("Runners will update at").length - 1 + (text.match(/runner update at \d/g)?.length ?? 0),
    insideBox: ps.every((p) => { const r = p.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; }),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

describe.skipIf(!browser)("Updates status box words a wrap-up from the one update it is tied to (BOS-2672)", () => {
  for (const w of [{ name: "brave-1667", width: 1667, height: 724 }, { name: "safari-1550", width: 1550, height: 1611 }, { name: "phone-380", width: 380, height: 844 }]) {
    for (const s of states) {
      it(`${w.name} ${s.name}: names it once, never "no update was waiting" beside an update line, inside the box, no sideways scroll`, async () => {
        const page = await browser!.newPage({ viewport: { width: w.width, height: w.height } });
        try {
          await page.setContent(pageHtml(s.maint, s.v), { waitUntil: "load" });
          const got = await page.evaluate(read);
          expect(got.text).toMatch(s.names);
          expect(got.runnerTimes).toBeLessThanOrEqual(1);
          expect(/no update was waiting/i.test(got.text)).toBe(s.noneWaiting);
          if (s.noneWaiting) expect(got.text).not.toMatch(/runner update|server update|Runners will|trial/i);
          expect(got.insideBox).toBe(true);
          expect(got.overflow).toBeLessThanOrEqual(0);
          if (out) {
            mkdirSync(out, { recursive: true });
            await page.screenshot({ path: path.join(out, `bos-2672-${w.name}-${s.name}.png`), fullPage: true });
          }
        } finally {
          await page.close();
        }
      });
    }
  }
});
