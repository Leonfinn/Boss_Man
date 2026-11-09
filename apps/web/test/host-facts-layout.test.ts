import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport } from "@boss-man/shared";

// A rendering check of Settings → This host (BOS-924), not a CSS-text test: long fact values (a comma list
// of compose files, a comma list of IPs) must wrap inside the panel at a desktop width and at the owner's
// recorded profiles, with the reported facts folded and open. The same markup ThisHost.tsx renders is put
// in a headless browser with the real styles.css. Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// Long enough to overflow any window: the host's own compose files and every address it listens on.
const COMPOSE = Array.from({ length: 9 }, (_, i) => `deploy/truenas-${["deployer", "bluegreen", "tailscale", "loki", "grafana", "prometheus", "alerts", "backups", "web"][i]}.yml`).join(",");
const ADDRESSES = [
  "192.168.1.25",
  "fd01:9689:a583:bbe:dc10:aa6:91cb:ae19",
  "172.19.0.1",
  "172.18.0.1",
  "172.17.0.1",
  "172.30.0.24",
  "172.20.0.1",
  "172.21.0.1",
  "172.22.0.1",
  "172.23.0.1",
  "172.24.0.1",
  "172.25.0.1",
  "10.0.0.14",
  "10.0.0.15",
  "100.101.102.103",
].join(",");

const facts: [string, string][] = [
  ["addon.ntfy", "running"],
  ["addon.penpot", "running"],
  ["addon.tailscale", "running"],
  ["check.container_status.notRunning", "2"],
  ["check.container_status.total", "18"],
  ["check.restart_counts.max", "1"],
  ["check.state_file_sizes.deployer.log", "778478"],
  ["compose.bluegreen", "true"],
  ["compose.files", COMPOSE],
  ["compose.liveColour", "blue"],
  ["memory.availableKb", "26904756"],
  ["memory.totalKb", "41011056"],
  ["network.addresses", ADDRESSES],
  ["network.port.BOSSMAN_BIND", "192.168.1.25"],
  ["network.port.BOSSMAN_HOST_PORT", "3101"],
  ["paths.deployer", "/srv/apps/boss-man/deployer"],
  ["paths.install", "/srv/apps/boss-man"],
  ["repo.originHost", "github.com"],
  ["repo.probe", "failed"],
];

// The same structure ThisHost renders: the intro, the folded reported-facts block, then the owner's boxes.
const HTML = (open: boolean) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body { margin: 0; } .app { flex-wrap: nowrap; } .app > nav { flex: 0 0 232px; } main { padding: 32px 40px 56px; }
</style></head><body><div class="app"><nav class="side" aria-label="Main"></nav><main>
<section class="card" aria-labelledby="this-host-h" style="display: flex; flex-direction: column; gap: 14px">
<h2 id="this-host-h" style="font-size: 17px; font-weight: 600">This host</h2>
<p class="muted" style="font-size: 14px">What the host Docker01 last told Boss Man about itself, 9 Nov 09:48. Agents' cards use these facts, so a card can't be raised while one it needs is missing.</p>
<div class="host-facts">
<button type="button" class="host-facts-toggle" aria-expanded="${open}" aria-controls="host-facts-body" data-testid="toggle">
<span class="pl-arrow" aria-hidden="true">${open ? "▾" : "▸"}</span>
<span>Reported facts (${facts.length}) — Docker01, 9 Nov 09:48</span>
<span class="tag amber" data-testid="host-facts-problems">1 check failing</span>
</button>
<div id="host-facts-body"${open ? "" : ` hidden style="display: none"`}>
<dl data-testid="host-facts" class="host-facts-list">
${facts.map(([k, v]) => `<dt class="mono">${k}</dt><dd><span class="mono host-fact-value">${v}</span> <span class="muted">(reported by the host)</span></dd>`).join("")}
</dl>
</div>
</div>
<h3 style="font-size: 15px; font-weight: 600">Facts only you can give</h3>
<div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap"><label for="hf-1">Address you reach Boss Man at from outside</label><input id="hf-1" class="mono" /></div>
<div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap"><label for="hf-2">Deploy key added to the code host (yes or no)</label><input id="hf-2" class="mono" /></div>
</section>
</main></div></body></html>`;

const profiles = (() => {
  const dir = new URL("./device-profiles/", import.meta.url);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, parsed: DeviceReport.parse(JSON.parse(readFileSync(new URL(f, dir), "utf8"))) }))
      .map((p) => {
        const r = p.parsed.readings.find((x) => x.afterScroll) ?? p.parsed.readings[0]!;
        return { file: p.file, width: r.width, height: r.height, deviceScaleFactor: r.pixelRatio, hasTouch: r.coarsePointer };
      });
  } catch {
    return [];
  }
})();

type Page = {
  setViewportSize: (v: { width: number; height: number }) => Promise<void>;
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
  close: () => Promise<void>;
};
type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean }) => Promise<Page>;
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

type Measured = {
  panelRight: number;
  panelOverflow: number;
  pageOverflow: number;
  rows: { key: string; dtRight: number; ddRight: number; ddLeft: number; dtTop: number; ddTop: number; lines: number }[];
  ownerVisible: boolean;
  ownerBoxesVisible: boolean;
  factsVisible: boolean;
  troubleVisible: boolean;
};

async function measure(page: Page, width: number, height: number, open: boolean): Promise<Measured> {
  await page.setViewportSize({ width, height });
  await page.setContent(HTML(open), { waitUntil: "load" });
  return page.evaluate<Measured, void>(() => {
    const panelEl = document.querySelector("section.card") as HTMLElement;
    const panel = panelEl.getBoundingClientRect();
    // The panel's own right inner edge: padding included in the box, the border not.
    const innerRight = panel.right - parseFloat(getComputedStyle(panelEl).borderRightWidth);
    // The furthest any piece of the panel's content reaches to the right, folded or open.
    let contentRight = -Infinity;
    for (const el of panelEl.querySelectorAll("*")) {
      const b = el.getBoundingClientRect();
      if (b.width > 0) contentRight = Math.max(contentRight, b.right);
    }
    const list = document.querySelector("[data-testid=host-facts]")!;
    const rows = [...(list.querySelectorAll("dt") as NodeListOf<HTMLElement>)].map((dt) => {
      const dd = dt.nextElementSibling as HTMLElement;
      const value = dd.querySelector(".host-fact-value") as HTMLElement;
      const lh = parseFloat(getComputedStyle(dd).lineHeight);
      const valueBox = value.getBoundingClientRect();
      return {
        key: dt.textContent!,
        dtRight: dt.getBoundingClientRect().right,
        ddRight: dd.getBoundingClientRect().right,
        ddLeft: dd.getBoundingClientRect().left,
        dtTop: dt.getBoundingClientRect().top,
        ddTop: dd.getBoundingClientRect().top,
        lines: Math.round(valueBox.height / lh),
      };
    });
    const intro = [...document.querySelectorAll("p.muted")].find((p) => p.textContent?.startsWith("What the host"));
    const owner = [...document.querySelectorAll("h3")].find((h) => h.textContent === "Facts only you can give");
    const body = document.getElementById("host-facts-body")!;
    const visible = (el: Element | undefined | null) => !!el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== "hidden";
    const toggle = document.querySelector("[data-testid=toggle]")!;
    return {
      panelRight: panel.right,
      panelOverflow: contentRight - innerRight,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rows,
      ownerVisible: visible(intro),
      ownerBoxesVisible: visible(owner) && visible(document.getElementById("hf-1")) && visible(document.getElementById("hf-2")),
      factsVisible: visible(body),
      troubleVisible: visible(toggle.querySelector("[data-testid=host-facts-problems]")),
    };
  });
}

function check(name: string, m: Measured, open: boolean) {
  // Nothing runs off the panel or the page, folded or open.
  expect(m.panelOverflow, `${name}: nothing overflows the panel`).toBeLessThanOrEqual(0);
  expect(m.pageOverflow, `${name}: nothing runs off the page`).toBeLessThanOrEqual(0);
  // The owner's boxes and the intro line are always visible, folded or not.
  expect(m.ownerVisible, `${name}: the intro line is visible`).toBe(true);
  expect(m.ownerBoxesVisible, `${name}: "Facts only you can give" stays visible`).toBe(true);
  // A problem is in the folded header, so folding never hides it.
  expect(m.troubleVisible, `${name}: the problem shows in the header`).toBe(true);
  expect(m.factsVisible, `${name}: facts ${open ? "show" : "stay folded"}`).toBe(open);
  if (!open) return;
  // Every value stays inside the panel, the label column stays put, and a long one wraps onto more lines.
  let labelRight = 0;
  for (const r of m.rows) labelRight = Math.max(labelRight, r.dtRight);
  for (const r of m.rows) {
    expect(r.ddRight, `${name}: ${r.key} inside the panel`).toBeLessThanOrEqual(m.panelRight);
    expect(r.ddLeft, `${name}: ${r.key} value starts after the label column`).toBeGreaterThanOrEqual(labelRight);
    // A row's label and value sit on the same line: the value column never wraps under the label.
    expect(Math.abs(r.dtTop - r.ddTop), `${name}: ${r.key} label aligned with its value`).toBeLessThanOrEqual(1);
  }
  for (const key of ["compose.files", "network.addresses"]) {
    expect(m.rows.find((r) => r.key === key)!.lines, `${name}: ${key} wraps onto more than one line`).toBeGreaterThan(1);
  }
}

describe.skipIf(!browser)("This host facts layout (BOS-924)", () => {
  it("wraps long values inside the panel at desktop 1280, folded and open", async () => {
    const page = await browser!.newPage();
    try {
      for (const open of [false, true]) check(`desktop ${open ? "open" : "folded"}`, await measure(page, 1280, 800, open), open);
    } finally {
      await page.close();
    }
  });

  for (const p of profiles) {
    it(`does the same at ${p.file} (${p.width}x${p.height})`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.deviceScaleFactor, hasTouch: p.hasTouch });
      try {
        for (const open of [false, true]) check(`${p.file} ${open ? "open" : "folded"}`, await measure(page, p.width, p.height, open), open);
      } finally {
        await page.close();
      }
    });
  }
});
