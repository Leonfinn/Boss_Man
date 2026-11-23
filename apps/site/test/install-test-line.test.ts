import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build, installTestText } from "../scripts/build.mjs";

// BOS-1488: the install guide shows when the install last passed and how long it took, from the newest release's
// install-result.json. A failed or missing result must never read as a pass, and "about 20 minutes" is gone.
const tmp = mkdtempSync(path.join(tmpdir(), "install-line-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const result = (name: string, body: unknown) => {
  const f = path.join(tmp, name);
  writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
  return f;
};

describe("installTestText", () => {
  it("a pass says the date, the version and the minutes", () => {
    const t = installTestText(result("pass.json", { version: "0.1.0-beta.1", date: "2026-11-23", result: "pass", minutes: 6.4 }));
    expect(t.line).toContain("Last tested on 23 November 2026 with 0.1.0-beta.1, took 6 minutes.");
    expect(t.time).toContain("about 6 minutes");
  });

  it("a failure says it failed and gives no minutes", () => {
    const t = installTestText(result("fail.json", { version: "0.1.0", date: "2026-11-24", result: "fail", minutes: 5 }));
    expect(t.line).toContain("failed on 24 November 2026");
    expect(t.line).not.toContain("Last tested");
    expect(t.time).toBe("");
  });

  it.each([
    ["no file", undefined],
    ["a missing file", path.join(tmp, "nope.json")],
    ["broken JSON", result("broken.json", "{not json")],
    ["a skipped result", result("skip.json", { version: "0.1.0", date: "2026-11-23", result: "skipped", minutes: 3 })],
    ["a pass with no minutes", result("nomin.json", { version: "0.1.0", date: "2026-11-23", result: "pass" })],
    ["a bad date", result("baddate.json", { version: "0.1.0", date: "yesterday", result: "pass", minutes: 3 })],
    ["a version with markup", result("badver.json", { version: "<b>x</b>", date: "2026-11-23", result: "pass", minutes: 3 })],
  ])("%s says not yet tested", (_name, file) => {
    const t = installTestText(file as string | undefined);
    expect(t.line).toContain("Not yet tested on a fresh machine");
    expect(t.time).toBe("");
  });
});

describe("the built install guide", () => {
  const guide = (file?: string) => {
    const out = path.join(tmp, `dist-${file ? "with" : "without"}`);
    build({ outDir: out, siteUrl: "", portalUrl: "", installResultFile: file });
    return readFileSync(path.join(out, "guides/install-boss-man.html"), "utf8");
  };

  it("shows the measured time and no guess", () => {
    const html = guide(result("g.json", { version: "0.1.0-beta.1", date: "2026-11-23", result: "pass", minutes: 7 }));
    expect(html).toContain("Last tested on 23 November 2026 with 0.1.0-beta.1, took 7 minutes.");
    expect(html).not.toContain("About 20 minutes");
    expect(html).not.toContain("{{install");
  });

  it("without a result it says so, and drops the old notice and the guess", () => {
    const html = guide();
    expect(html).toContain("Not yet tested on a fresh machine");
    expect(html).not.toContain("About 20 minutes");
    expect(html).not.toContain("was not re-run on a fresh machine");
    expect(html).not.toContain("{{install");
  });
});
