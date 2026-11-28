// @vitest-environment jsdom
// BOS-2825: the Credentials table's "Ends in" column now shows the token's real end date (or "No date"), and the add
// form has an "Ends on" date field for a token kind. Rendered to markup with the real styles.css and read in a headless
// browser at the owner's two devices and a phone: the date cell stays inside its column on one line, the form's date
// field sits inside its row, and nothing runs off the table. A real-browser check, not a CSS-text one. Skipped, not
// failed, where no browser is installed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Credentials } from "../src/pages/settings/Credentials";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

// A long secret name and two dates, so the cell must fit "27 Nov 2027" and "No date" without pushing the row around.
const grants = [
  { id: "g1", envName: "CLAUDE_CODE_OAUTH_TOKEN", secretId: "s1", secretName: "App Co Claude setup-token for the whole team", hint: "••••1234", deployTargetId: null, agentIds: [], expiresAt: "2027-11-27" },
  { id: "g2", envName: "GIT_TOKEN", secretId: "s2", secretName: "App Co git token", hint: "••••5678", deployTargetId: null, agentIds: [], expiresAt: null },
  { id: "g3", envName: "GITHUB_WATCH_TOKEN", secretId: "s3", secretName: "App Co GitHub watcher", hint: "••••9012", deployTargetId: null, agentIds: [], expiresAt: "2027-02-05" },
];
const secretsList = [
  { id: "s1", name: "App Co Claude setup-token for the whole team", kind: "claude_oauth_token", hint: "••••1234", expiresAt: "2027-11-27" },
  { id: "s2", name: "App Co git token", kind: "generic", hint: "••••5678", expiresAt: null },
  { id: "s3", name: "App Co GitHub watcher", kind: "generic", hint: "••••9012", expiresAt: "2027-02-05" },
];

let html = "";
beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url === "/api/companies/c1/grants" ? grants : url === "/api/secrets" ? secretsList : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  const { container, findByText } = (await import("@testing-library/react")).render(<Credentials company={company} />);
  await findByText("CLAUDE_CODE_OAUTH_TOKEN");
  // Pick the Claude kind so the "Ends on" date field is drawn, as the owner would.
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const select = container.querySelector("#cred-kind") as HTMLSelectElement;
  fireEvent.change(select, { target: { value: String([...select.options].findIndex((o) => o.textContent === "Claude setup-token")) } });
  await waitFor(() => expect(container.querySelector("#cred-ends")).toBeTruthy());
  html = container.innerHTML;
});

afterAll(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

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

const scratch = process.env.BOSSMAN_SCRATCH;
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `credentials-ends-on-${name}.png`) : null);

const doc = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; } main { padding: 16px; }
</style></head><body><main>${html}</main></body></html>`;

/** The "Ends in" cells and the date field, measured against their own row and the page. */
const read = () => {
  const txt = (el: Element | null) => (el?.textContent ?? "").trim();
  const headers = [...document.querySelectorAll("table thead th")].map(txt);
  const endsIdx = headers.findIndex((h) => h === "Ends in");
  const cells = [...document.querySelectorAll("table tbody tr")].map((tr) => {
    const td = tr.querySelectorAll("td")[endsIdx] as HTMLElement | undefined;
    const row = tr.getBoundingClientRect();
    const r = td?.getBoundingClientRect();
    const range = td ? document.createRange() : null;
    if (td && range) range.selectNodeContents(td);
    const lineCount = range ? range.getClientRects().length : 0;
    return {
      text: txt(td ?? null),
      sh: r?.height ?? 0,
      inside: !!r && r.left >= row.left - 0.5 && r.right <= row.right + 0.5,
      oneLine: lineCount <= 1,
      overflow: td ? td.scrollWidth - td.clientWidth : 0,
    };
  });
  const figs = [...document.querySelectorAll("form .field")] as HTMLElement[];
  const dateField = figs.find((f) => f.querySelector("#cred-ends"));
  const form = dateField?.closest("form") as HTMLElement | null;
  const input = dateField?.querySelector("#cred-ends") as HTMLInputElement | null;
  const fb = form?.getBoundingClientRect();
  const ib = input?.getBoundingClientRect();
  const hint = document.querySelector("#cred-ends-hint") as HTMLElement | null;
  return {
    headers,
    cells,
    looksLikeDate: cells.map((c) => /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(c.text) || c.text === "No date"),
    dateFieldShown: !!ib && ib.width > 0 && ib.height > 0,
    dateFieldLabel: txt(dateField?.querySelector("label") ?? null),
    dateFieldInsideForm: !!fb && !!ib && ib.left >= fb.left - 0.5 && ib.right <= fb.right + 0.5,
    dateFieldValue: input?.value ?? "",
    hintShown: !!hint && (hint.getBoundingClientRect().height > 0),
    pageScroll: document.documentElement.scrollWidth - window.innerWidth,
  };
};

const devices = [
  { name: "brave-1667", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("Credentials end date renders on the real page (BOS-2825)", () => {
  it("built the table with the end-date column and the form's date field", () => {
    expect(html).toContain("Ends in");
    expect(html).toContain("27 Nov 2027");
    expect(html).toContain("No date");
    expect(html).toContain("cred-ends");
  });

  for (const d of devices) {
    it(`${d.name}: the date cells and the Ends on field fit, one line, no overflow`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(doc(), { waitUntil: "load" });
        const m = (await page.evaluate(read)) as ReturnType<typeof read>;
        expect(m.headers).toContain("Ends in");
        expect(m.cells).toHaveLength(3);
        // Each cell is a real date or "No date", inside its row, and the table doesn't scroll sideways.
        expect(m.looksLikeDate).toEqual([true, true, true]);
        for (const c of m.cells) {
          expect(c.inside).toBe(true);
          expect(c.sh).toBeGreaterThan(0);
          expect(c.overflow).toBeLessThanOrEqual(1);
        }
        // On the owner's desktop screens the date is one line per row; on a phone the table scrolls in its wrap, so a
        // short wrap of the date is allowed there, never an overlap or a cell running off the page.
        if (d.name !== "phone-390") for (const c of m.cells) expect(c.oneLine).toBe(true);
        // The new date field is drawn, labelled, empty (the owner has not picked a kind's default here), and inside the form.
        expect(m.dateFieldShown).toBe(true);
        expect(m.dateFieldLabel).toBe("Ends on");
        expect(m.dateFieldInsideForm).toBe(true);
        expect(m.hintShown).toBe(true);
        expect(m.pageScroll).toBeLessThanOrEqual(1);
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
