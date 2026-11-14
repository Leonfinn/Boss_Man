import { describe, expect, it } from "vitest";
import { MIN_SHRINK, SHRINK_FRACTION, shrinkRefusalAgainst } from "../src/services/wiki.js";

const text = (n: number) => "x".repeat(n);

describe("wiki shrink guard limits (BOS-1333)", () => {
  it("pins the quarter rule and the 40-character floor", () => {
    expect(SHRINK_FRACTION).toBe(0.25);
    expect(MIN_SHRINK).toBe(40);
  });

  it("allows a body the same length or longer", () => {
    expect(shrinkRefusalAgainst(text(100), 100, text(100))).toBeNull();
    expect(shrinkRefusalAgainst(text(100), 100, text(120))).toBeNull();
  });

  it("allows a 30-character cut on a 100-character page, even though it is over a quarter", () => {
    // 25% of 100 is 25, but the 40-character floor means a cut this small is an ordinary edit.
    expect(shrinkRefusalAgainst(text(100), 100, text(70))).toBeNull();
  });

  it("treats removing exactly a quarter of a 400-character page as allowed, and one more character as a refusal", () => {
    expect(shrinkRefusalAgainst(text(400), 400, text(300))).toBeNull();
    const refused = shrinkRefusalAgainst(text(400), 400, text(299));
    expect(refused).not.toBeNull();
    expect(refused).toContain("101 characters");
  });

  it("measures from the page's largest size when it used to be bigger, and says so", () => {
    // The page holds 300 characters now but has held 1,000 before: cutting to 290 is measured from 1,000.
    const refused = shrinkRefusalAgainst(text(300), 1000, text(290));
    expect(refused).not.toBeNull();
    expect(refused).toContain("can't be cut this far by small steps");
    expect(refused).toContain("1,000");
  });

  it("names a single dropped heading and describes several as 'these headings'", () => {
    const oneBefore = "## Notes\n\n## Tips\n\nx";
    const one = shrinkRefusalAgainst(oneBefore, oneBefore.length, "## Tips\n\nx");
    expect(one).toContain('drop the heading: "Notes"');

    const twoBefore = "## Notes\n\n## Tips\n\n## More\n\nx";
    const two = shrinkRefusalAgainst(twoBefore, twoBefore.length, "## More\n\nx");
    expect(two).toContain("these headings");
    expect(two).toContain('"Notes"');
    expect(two).toContain('"Tips"');
  });

  it("does not count a heading whose case changed only as dropped", () => {
    const before = "## Notes\n\nhello world";
    const after = "## NOTES\n\nhello worl";
    expect(after.length).toBeLessThan(before.length);
    expect(shrinkRefusalAgainst(before, before.length, after)).toBeNull();
  });

  it("every refusal ends with the advice to use append or replace: true", () => {
    const refusals = [
      shrinkRefusalAgainst(text(400), 400, text(299)),
      shrinkRefusalAgainst(text(300), 1000, text(290)),
      shrinkRefusalAgainst("## Notes\n\n## Tips\n\nx", "## Notes\n\n## Tips\n\nx".length, "## Tips\n\nx"),
      shrinkRefusalAgainst("## Notes\n\n## Tips\n\n## More\n\nx", "## Notes\n\n## Tips\n\n## More\n\nx".length, "## More\n\nx"),
    ];
    for (const refused of refusals) {
      expect(refused).toContain("use append");
      expect(refused).toContain("replace: true");
    }
  });
});
