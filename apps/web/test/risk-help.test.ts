// BOS-1618 (Background lane): the pure helper behind the compact risk-level list had no direct test.
// shortSummary drops the shared "the check runs before it merges" sentence (the list's top line already
// says it once), trims each part and joins the rest back with one full stop.
import { describe, expect, it } from "vitest";
import { shortSummary } from "../src/components/RiskHelp";

describe("risk level short summary (BOS-1195)", () => {
  it("drops the shared check sentence rather than repeating it on every level", () => {
    expect(shortSummary("Only you merge; the project's check runs before it merges.")).toBe("Only you merge.");
    expect(shortSummary("You sign off; the project's check and its deeper check run before it merges.")).toBe("You sign off.");
  });

  it("drops the check sentence whether or not it ends the whole summary with a full stop", () => {
    expect(shortSummary("the project's check runs before it merges")).toBe(".");
    expect(shortSummary("A plan comes first; the project's check runs before it merges")).toBe("A plan comes first.");
  });

  it("keeps every other part in order, trimmed and joined with a semicolon and a space", () => {
    expect(shortSummary("  A plan comes first ;  a senior developer reviews it  ; you sign off  ")).toBe(
      "A plan comes first; a senior developer reviews it; you sign off.",
    );
  });

  it("ends with exactly one full stop, adding one only when it is missing", () => {
    expect(shortSummary("Only you merge")).toBe("Only you merge.");
    expect(shortSummary("Only you merge.")).toBe("Only you merge.");
  });

  it("only drops the sentence when it matches the shared wording exactly", () => {
    expect(shortSummary("The project's check runs before it merges in staging.")).toBe(
      "The project's check runs before it merges in staging.",
    );
    expect(shortSummary("A deeper check runs before it merges.")).toBe("A deeper check runs before it merges.");
  });
});
