// BOS-2076: a pass on an after-merge criterion given before the work is live is stored as "not yet checked".
import { describe, expect, it } from "vitest";
import { holdEarlyAfterMergePasses, readVerdicts, type Criterion } from "../src/acceptance.js";

const TEXT = "After the next publish, Bing shows the submitted URLs and Google shows the sitemap read with no errors";
const crit: Criterion[] = ["The tests pass", { text: TEXT, after: "merge" }];
const verdicts = (note: string) => readVerdicts(crit, note).map((v) => v.verdict);

describe("holdEarlyAfterMergePasses", () => {
  it("turns a numbered after-merge pass into not yet checked and keeps the before-merge pass", () => {
    const r = holdEarlyAfterMergePasses(crit, "1 pass; 2 pass");
    expect(r.held).toEqual([TEXT]);
    expect(r.note).toContain("not yet checked");
    expect(verdicts(r.note)).toEqual(["pass", null]);
  });
  it("keeps the first pass when both sit in one comma list", () => {
    expect(verdicts(holdEarlyAfterMergePasses(crit, "1 pass, 2 pass").note)).toEqual(["pass", null]);
  });
  it("turns a worded after-merge pass", () => {
    const r = holdEarlyAfterMergePasses(crit, "1 pass; Bing shows the submitted URLs and Google shows the sitemap read with no errors: passes");
    expect(verdicts(r.note)).toEqual(["pass", null]);
  });
  it("leaves a fail and a note with no after-merge pass untouched", () => {
    expect(holdEarlyAfterMergePasses(crit, "1 pass; 2 fail: not live")).toEqual({ note: "1 pass; 2 fail: not live", held: [] });
    expect(holdEarlyAfterMergePasses(crit, "1 pass")).toEqual({ note: "1 pass", held: [] });
  });
});
