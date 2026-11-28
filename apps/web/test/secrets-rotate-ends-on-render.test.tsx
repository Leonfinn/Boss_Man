// @vitest-environment jsdom
// BOS-2825 (after Rod's review): the Secrets page's Rotate form now has an "Ends on" date field for a token kind, and
// the secret's own end date shows in its list row. Rendered to markup with the real styles.css and read in a headless
// browser at the owner's two devices and a phone: the Rotate date field sits inside its form next to the value box, the
// row's end date stays in the header, and nothing runs off the page. Skipped, not failed, where no browser is installed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Secrets } from "../src/pages/Secrets";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const grants = [
  { id: "g1", envName: "CLAUDE_CODE_OAUTH_TOKEN", secretId: "s1", secretName: "App Co Claude token", hint: "••••1234", deployTargetId: null, agentIds: [], expiresAt: "2027-11-27" },
  { id: "g2", envName: "GIT_TOKEN", secretId: "s2", secretName: "App Co git token", hint: "••••5678", deployTargetId: null, agentIds: [], expiresAt: null },
];
// One token kind (has a Rotate date field) and one that can't expire (must not draw it).
const secretsList = [
  { id: "s1", name: "App Co Claude token", kind: "claude_oauth_token", hint: "••••1234", version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", expiresAt: "2027-11-27" },
  { id: "s2", name: "App Co API key", kind: "anthropic_api_key", hint: "••••5678", version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", expiresAt: null },
];

let html = "";
beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.includes("/access-log")
        ? { entries: [], summary: { total: 0, byCompany: [], byPurpose: { run: 0, deploy: 0, merge: 0, other: 0 }, perDay: Array(30).fill(0) } }
        : url.includes("/grants")
          ? grants
          : url === "/api/secrets"
            ? secretsList
            : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  const rtl = await import("@testing-library/react");
  const { container, findAllByText } = rtl.render(<Secrets companies={[company]} companyId="c1" />);
  await rtl.waitFor(() => expect(container.querySelectorAll("button.secret-head")).toHaveLength(2));
  await findAllByText("All stored secrets");
  // Open the token's detail, as the owner would to rotate it.
  rtl.fireEvent.click(container.querySelectorAll("button.secret-head")[0]!);
  await rtl.waitFor(() => expect(container.querySelector("#rotate-s1")).toBeTruthy());
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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `secrets-rotate-ends-on-${name}.png`) : null);

const doc = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; } main { padding: 16px; }
</style></head><body><main>${html}</main></body></html>`;

const read = () => {
  const txt = (el: Element | null) => (el?.textContent ?? "").trim();
  const rotate = document.querySelector("#rotate-s1") as HTMLInputElement | null;
  const ends = document.querySelector("#rotate-ends-s1") as HTMLInputElement | null;
  const form = rotate?.closest("form") as HTMLElement | null;
  const fb = form?.getBoundingClientRect();
  const eb = ends?.getBoundingClientRect();
  const hint = document.querySelector("#rotate-ends-hint-s1") as HTMLElement | null;
  const rows = [...document.querySelectorAll("button.secret-head")].map((h) => {
    const r = h.getBoundingClientRect();
    const spans = [...h.querySelectorAll("span")];
    const dateSpan = spans.find((s) => /^(ends .*|no end date)$/.test(txt(s)));
    const db = dateSpan?.getBoundingClientRect();
    return { text: txt(h), date: txt(dateSpan ?? null), dateInside: !!db && db.left >= r.left - 0.5 && db.right <= r.right + 0.5, height: r.height };
  });
  return {
    rotateShown: !!eb && eb.width > 0 && eb.height > 0,
    rotateLabel: txt(form?.querySelector("label[for='rotate-ends-s1']") ?? null),
    // An API-key secret can't expire, so it has no Rotate date field.
    noFieldForApiKey: !document.querySelector("#rotate-ends-s2"),
    rotateInsideForm: !!fb && !!eb && eb.left >= fb.left - 0.5 && eb.right <= fb.right + 0.5,
    hintShown: !!hint && hint.getBoundingClientRect().height > 0,
    rows,
    pageScroll: document.documentElement.scrollWidth - window.innerWidth,
  };
};

const devices = [
  { name: "brave-1667", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("Secrets rotate end date renders on the real page (BOS-2825)", () => {
  it("drew the Rotate date field and the row's end date", () => {
    expect(html).toContain("rotate-ends-s1");
    expect(html).toContain("ends 27 Nov 2027");
    expect(html).toContain("no end date");
  });

  for (const d of devices) {
    it(`${d.name}: the Rotate date field and the row's end date fit, no overflow`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(doc(), { waitUntil: "load" });
        const m = (await page.evaluate(read)) as ReturnType<typeof read>;
        expect(m.rotateShown).toBe(true);
        expect(m.rotateLabel).toBe("Ends on");
        expect(m.noFieldForApiKey).toBe(true);
        expect(m.rotateInsideForm).toBe(true);
        expect(m.hintShown).toBe(true);
        expect(m.rows).toHaveLength(2);
        expect(m.rows[0]!.date).toBe("ends 27 Nov 2027");
        for (const r of m.rows) {
          expect(r.dateInside).toBe(true);
          expect(r.height).toBeGreaterThan(0);
        }
        expect(m.pageScroll).toBeLessThanOrEqual(1);
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
