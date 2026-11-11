import { describe, expect, it } from "vitest";
import { checkFailureFacts, checkFailureSentence, checkLogFacts, withCheckFacts } from "../src/check-log.js";

const LOG = "PASS  merge check\nFAIL  typecheck (exit 2)\n      error TS1\nFAIL  related tests (exit 1)\n       FAIL  test/a.test.ts > suite > first\n       FAIL  test/b.test.ts > second\ncheck-quick: FAILED\n";

describe("check log facts (BOS-1220)", () => {
  it("finds the failed steps and the first failing test", () => {
    expect(checkLogFacts(LOG)).toEqual({ steps: ["typecheck (exit 2)", "related tests (exit 1)"], test: "test/a.test.ts > suite > first" });
    expect(checkFailureFacts(LOG)).toBe('steps that failed: "typecheck (exit 2)"; "related tests (exit 1)". first failing test: test/a.test.ts > suite > first');
  });

  it("ignores colour codes", () => {
    expect(checkLogFacts("\u001b[31mFAIL\u001b[0m  x\n").steps).toEqual(["x"]);
  });

  it("puts the facts in front of a tail that has lost them", () => {
    const long = LOG + "x".repeat(20_000);
    const out = withCheckFacts(long, 8192);
    expect(out.length).toBeLessThanOrEqual(8192);
    expect(out.startsWith("[Earlier in the log:")).toBe(true);
    expect(out).toContain("related tests (exit 1)");
    // A tail that still shows them is left alone.
    expect(withCheckFacts(LOG, 8192)).toBe(LOG);
  });

  it("says plainly when a check was stopped, never undefined", () => {
    expect(checkFailureSentence({ exitCode: undefined, output: "" })).toBe("was stopped before it reported");
    expect(checkFailureSentence({ exitCode: null, output: "", reason: "killed by the server" })).toBe("was stopped before it reported: killed by the server");
    expect(checkFailureSentence({ exitCode: 1, output: "" })).toBe("failed (exit code 1)");
  });
});
