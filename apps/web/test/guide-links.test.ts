import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE_BASE, GUIDE_SLUGS, guideHref } from "../src/guide-links";

// BOS-2832: the "What's this?" links point at the website's guides. A linked address must be a page
// that exists in apps/site/src/guides, so a renamed or removed guide breaks this test, not the app.

const guidesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../site/src/guides");

describe("guide links", () => {
  it("every linked guide is a real page in the website's guides folder", () => {
    for (const slug of GUIDE_SLUGS) {
      expect(existsSync(path.join(guidesDir, `${slug}.md`)), `apps/site/src/guides/${slug}.md is missing`).toBe(true);
    }
  });

  it("builds a new-tab address on the published website, with an optional section anchor", () => {
    expect(guideHref("the-runner")).toBe(`${GUIDE_BASE}/guides/the-runner`);
    expect(guideHref("connect-a-claude-account", "setup-token")).toBe(`${GUIDE_BASE}/guides/connect-a-claude-account#setup-token`);
  });

  it("lists no guide address twice", () => {
    expect(new Set(GUIDE_SLUGS).size).toBe(GUIDE_SLUGS.length);
  });
});
