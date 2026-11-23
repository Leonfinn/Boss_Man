// The Run page header line: model, four token counts and cost; unreported figures say so, never 0 (BOS-2367).
import { describe, expect, it } from "vitest";
import { runFigures } from "../src/pages/Run";

const base = { model: "claude-opus", inputTokens: 41000, outputTokens: 3000, cachedReadTokens: 1_200_000, cachedWriteTokens: 80000, fundingKind: "api_key", costMicros: 420_000 };

describe("runFigures", () => {
  it("shows model, all four counts and the cost for a pay-as-you-go run", () => {
    expect(runFigures(base as never)).toBe("claude-opus · 41.0k in · 3.0k out · 1.2M cache read · 80.0k cache write · $0.42");
  });
  it("says plan use instead of money on a subscription", () => {
    expect(runFigures({ ...base, fundingKind: "subscription", costMicros: 0 } as never)).toContain("· plan use");
  });
  it("says not reported for missing counts, and keeps a real 0", () => {
    const line = runFigures({ ...base, inputTokens: null, cachedReadTokens: 0 } as never);
    expect(line).toContain("in not reported");
    expect(line).toContain("0 cache read");
  });
});
