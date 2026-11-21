import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_LOAD_LIMIT, firstLoadFiles, firstLoadProblems, measureFirstLoad } from "../first-load";
import { SETTINGS_PAGES } from "../src/pages/Settings";
import { SETTINGS_PAGE_IDS, settingsRedirect } from "../src/pages/settings-redirect";

const html = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/main-AAA.js"></script>
<link rel="modulepreload" crossorigin href="/assets/client-BBB.js">
<link rel="stylesheet" crossorigin href="/assets/main-CCC.css">
<link rel="icon" href="/favicon.js.png">
</head><body><div id="root"></div></body></html>`;

describe("first-load size check (BOS-1843)", () => {
  it("lists the scripts and module preloads index.html loads, not styles or icons", () => {
    expect(firstLoadFiles(html)).toEqual(["assets/main-AAA.js", "assets/client-BBB.js"]);
  });

  it("sizes the files raw and gzipped, and reports nothing for a first load inside the limit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "first-load-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets/main-AAA.js"), "a".repeat(1000));
    writeFileSync(path.join(dir, "assets/client-BBB.js"), "b".repeat(2000));
    const m = measureFirstLoad(dir, html);
    expect(m.raw).toBe(3000);
    expect(m.gzip).toBeLessThan(200);
    expect(firstLoadProblems(m)).toEqual([]);
  });

  it("names the limit and the biggest files when the first load is too big", () => {
    const m = { files: [{ file: "assets/main-AAA.js", raw: FIRST_LOAD_LIMIT.rawBytes + 1, gzip: 10 }], raw: FIRST_LOAD_LIMIT.rawBytes + 1, gzip: 10 };
    const problems = firstLoadProblems(m);
    expect(problems[0]).toContain("over the");
    expect(problems.join("\n")).toContain("assets/main-AAA.js");
    expect(problems.join("\n")).toContain("lazyPage");
    expect(firstLoadProblems({ ...m, raw: 10, gzip: FIRST_LOAD_LIMIT.gzipBytes + 1 })[0]).toContain("gzipped");
  });
});

describe("settings addresses outside the Settings page", () => {
  it("knows exactly the pages Settings shows, so the redirect never loads Settings itself", () => {
    expect([...SETTINGS_PAGE_IDS].sort()).toEqual(SETTINGS_PAGES.map((p) => p.id).sort());
  });

  it("keeps the old addresses working", () => {
    expect(settingsRedirect(["settings", "c1", "team"], "c1")).toBeNull();
    expect(settingsRedirect(["settings", "c1", "system"], "c1")).toBe("settings/c1/updates");
    expect(settingsRedirect(["rules", "all"], "c1")).toBe("settings/c1/permissions");
    expect(settingsRedirect(["settings", "c1", "gone"], "c1")).toBe("settings");
    expect(settingsRedirect(["settings", "updates"], "c1")).toBe("settings/c1/updates");
    expect(settingsRedirect(["settings", "updates"], undefined)).toBeNull();
  });
});
