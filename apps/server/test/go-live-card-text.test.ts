// BOS-2136: pin the pure wording helpers on a go-live card: when it counts as one, and how its undo is
// shown to the owner. They take no database, so this file imports only the service.
import { describe, expect, it } from "vitest";
import { rollbackLine, sayGoLive } from "../src/services/go-live-card.js";

describe("sayGoLive", () => {
  it("is false when no text talks about going live", () => {
    expect(sayGoLive()).toBe(false);
    expect(sayGoLive(undefined, "")).toBe(false);
    expect(sayGoLive("Shall I change the header?", "Update the footer")).toBe(false);
  });

  it("recognises publish, deploy, release, go live and production in any case", () => {
    const live = ["Publish the site", "PUBLISHED", "publishing now", "deploy it", "deployed", "deploying", "deployment", "release notes", "releases", "released", "go live", "going live", "goes live", "Production"];
    for (const text of live) expect(sayGoLive(text), text).toBe(true);
  });

  it("does not match a longer word that merely contains one", () => {
    expect(sayGoLive("publisher")).toBe(false);
    expect(sayGoLive("republished")).toBe(false);
    expect(sayGoLive("preproduction")).toBe(false);
    expect(sayGoLive("releasedate")).toBe(false);
  });

  it("is true when any one of several texts mentions it", () => {
    expect(sayGoLive(undefined, "Change the header", "Deploy it on Friday")).toBe(true);
  });
});

describe("rollbackLine", () => {
  it("shows an untagged undo as it is", () => {
    expect(rollbackLine("press the Rollback button in the dashboard")).toBe("How to undo it: press the Rollback button in the dashboard");
    expect(rollbackLine("  press Rollback  ")).toBe("How to undo it: press Rollback");
  });

  it("shows a tested undo with its note", () => {
    expect(rollbackLine("tested: 17 Nov, redeployed the previous build")).toBe("How to undo it (tested: 17 Nov, redeployed the previous build)");
    expect(rollbackLine("Tested:  done on a copy  ")).toBe("How to undo it (tested: done on a copy)");
  });

  it("shows a not-tested undo as not tried yet, with where it comes from", () => {
    expect(rollbackLine("not tested: https://example.com/docs/rollback, press Rollback")).toBe("How to undo it (not tried yet; from https://example.com/docs/rollback, press Rollback)");
    expect(rollbackLine("NOT TESTED: vendor docs say restore the backup")).toBe("How to undo it (not tried yet; from vendor docs say restore the backup)");
  });

  it("keeps a multi-line note after its tag", () => {
    expect(rollbackLine("tested: 17 Nov\nredeployed the old build")).toBe("How to undo it (tested: 17 Nov\nredeployed the old build)");
  });

  it("treats anything that isn't a tested or not tested tag as plain text", () => {
    expect(rollbackLine("testing: pressed the button")).toBe("How to undo it: testing: pressed the button");
  });
});
