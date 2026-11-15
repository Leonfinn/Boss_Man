// BOS-1546: the one-sentence merge status a board card shows.
import { describe, expect, it } from "vitest";
import { statusLineText } from "../src/pages/MergeQueue";

describe("statusLineText", () => {
  it("says the step, since when, and what is in the way", () => {
    const text = statusLineText({ step: "waiting for a check slot (2 ahead)", since: "2026-11-15T09:10:00Z", next: "x", blocker: "BOS-7 must merge first." });
    expect(text).toMatch(/^Waiting for a check slot \(2 ahead\) · since .+\. In the way: BOS-7 must merge first\.$/);
  });

  it("leaves out the in-the-way part when nothing is", () => {
    expect(statusLineText({ step: "running the merge check", since: "2026-11-15T09:10:00Z", next: "", blocker: null })).not.toContain("In the way");
  });
});
